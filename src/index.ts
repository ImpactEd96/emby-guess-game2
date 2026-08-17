import { Env } from './types';
import { GameRoom } from './gameroom';

export { GameRoom };

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Route to Durable Object for WebSocket
    if (url.pathname === '/ws') {
      const roomCode = url.searchParams.get('room') || 'default';
      const doId = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(doId);
      return stub.fetch(request);
    }

    // API endpoints
    if (url.pathname === '/api/code') {
      const roomCode = url.searchParams.get('room') || 'default';
      const doId = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(doId);
      return stub.fetch(new Request(new URL('/code', url.origin).toString()));
    }

    if (url.pathname === '/api/state') {
      const roomCode = url.searchParams.get('room') || 'default';
      const doId = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(doId);
      return stub.fetch(new Request(new URL('/state', url.origin).toString()));
    }

    // Clip serving from R2
    const clipMatch = url.pathname.match(/^\/clip\/([A-Z0-9]+)\/(\d+)\/(.+)$/);
    if (clipMatch) {
      const [, roomCode, round, file] = clipMatch;
      const key = `clips/${roomCode}/${round}/${file}`;

      const object = await env.CLIPS_BUCKET.get(key);
      if (!object) {
        return new Response('Not found', { status: 404 });
      }

      const headers = new Headers(CORS_HEADERS);
      headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');

      return new Response(object.body, { headers });
    }

    // Poster proxy
    const posterMatch = url.pathname.match(/^\/poster\/(.+)$/);
    if (posterMatch) {
      const itemId = posterMatch[1];

      // Check R2 cache first
      const cacheKey = `posters/${itemId}`;
      const cached = await env.CLIPS_BUCKET.get(cacheKey);
      if (cached) {
        const headers = new Headers(CORS_HEADERS);
        headers.set('Content-Type', cached.httpMetadata?.contentType || 'image/jpeg');
        headers.set('Cache-Control', 'public, max-age=86400');
        return new Response(cached.body, { headers });
      }

      // Fetch from Emby
      const response = await fetch(
        `${env.EMBY_URL}/Items/${itemId}/Images/Primary?maxWidth=300&quality=90`,
        {
          headers: {
            'X-Emby-Token': env.EMBY_API_KEY,
          },
        }
      );

      if (!response.ok) {
        return new Response('Poster not found', { status: 404 });
      }

      // Cache in R2
      const contentType = response.headers.get('Content-Type') || 'image/jpeg';
      const body = await response.arrayBuffer();
      await env.CLIPS_BUCKET.put(cacheKey, body, {
        httpMetadata: { contentType },
      });

      const headers = new Headers(CORS_HEADERS);
      headers.set('Content-Type', contentType);
      headers.set('Cache-Control', 'public, max-age=86400');

      return new Response(body, { headers });
    }

    // Stage clip endpoint
    if (url.pathname === '/api/stage' && request.method === 'POST') {
      const body = await request.json() as { movieId: string; roomCode: string; roundNumber: number };
      const { movieId, roomCode, roundNumber } = body;

      await stageClip(env, movieId, roomCode, roundNumber);

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    // Debug endpoints
    if (url.pathname === '/api/debug/config') {
      return new Response(
        JSON.stringify({
          embyUrl: env.EMBY_URL ? 'configured' : 'missing',
          embyUserId: env.EMBY_USER_ID ? 'configured' : 'missing',
          embyApiKey: env.EMBY_API_KEY ? 'configured' : 'missing',
          clipQueueDepth: env.CLIP_QUEUE_DEPTH || '4',
          clipDurationSeconds: env.CLIP_DURATION_SECONDS || '3',
        }),
        { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      );
    }

    if (url.pathname === '/api/debug/emby' && request.method === 'GET') {
      try {
        const response = await fetch(`${env.EMBY_URL}/System/Info`, {
          headers: { 'X-Emby-Token': env.EMBY_API_KEY },
        });
        const data = await response.json() as { ServerName?: string };
        return new Response(
          JSON.stringify({ connected: true, serverName: data.ServerName }),
          { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ connected: false, error: String(error) }),
          { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }
    }

    if (url.pathname === '/api/debug/library' && request.method === 'GET') {
      try {
        const response = await fetch(
          `${env.EMBY_URL}/Users/${env.EMBY_USER_ID}/Items?IncludeItemTypes=Movie&Recursive=true&Fields=Id,Name&Limit=10`,
          {
            headers: { 'X-Emby-Token': env.EMBY_API_KEY },
          }
        );
        const data = await response.json() as { Items?: Array<{ Id: string; Name: string }> };
        return new Response(
          JSON.stringify({
            movieCount: data.Items?.length || 0,
            movies: data.Items?.slice(0, 5).map((i) => ({ id: i.Id, name: i.Name })),
          }),
          { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ error: String(error) }),
          { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }
    }

    if (url.pathname === '/api/debug/transcode' && request.method === 'GET') {
      const itemId = url.searchParams.get('itemId');
      if (!itemId) {
        return new Response(
          JSON.stringify({ error: 'itemId required' }),
          { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }

      try {
        const duration = parseInt(env.CLIP_DURATION_SECONDS || '3');
        const apiUrl = `${env.EMBY_URL}/Videos/${itemId}/master.m3u8?MediaSourceId=${itemId}&Static=false&VideoCodec=h264&AudioCodec=aac&VideoBitRate=2000000&AudioBitRate=128000&MaxStreamingBitrate=2000000&StartTimeSeconds=0`;
        const response = await fetch(apiUrl, {
          headers: { 'X-Emby-Token': env.EMBY_API_KEY },
        });

        const responseText = await response.text();

        return new Response(
          JSON.stringify({
            status: response.status,
            statusText: response.statusText,
            url: apiUrl,
            responsePreview: responseText.substring(0, 1000),
          }),
          { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ error: String(error) }),
          { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }
    }

    if (url.pathname === '/api/debug/r2' && request.method === 'GET') {
      try {
        const listed = await env.CLIPS_BUCKET.list({ limit: 5 });
        return new Response(
          JSON.stringify({
            bucketAccessible: true,
            sampleFiles: listed.objects.map((o) => o.key),
          }),
          { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ bucketAccessible: false, error: String(error) }),
          { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }
    }

    // Static assets fallback (serves from public/ directory)
    if ((env as any).ASSETS) {
      return (env as any).ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};

async function stageClip(env: Env, movieId: string, roomCode: string, roundNumber: number): Promise<void> {
  const duration = parseInt(env.CLIP_DURATION_SECONDS || '3');

  // Get HLS master playlist
  const masterResponse = await fetch(
    `${env.EMBY_URL}/Videos/${movieId}/master.m3u8?MediaSourceId=${movieId}&Static=false&VideoCodec=h264&AudioCodec=aac&VideoBitRate=2000000&AudioBitRate=128000&MaxStreamingBitrate=2000000&StartTimeSeconds=0`,
    {
      headers: { 'X-Emby-Token': env.EMBY_API_KEY },
    }
  );

  if (!masterResponse.ok) {
    throw new Error(`Failed to get master playlist: ${masterResponse.status}`);
  }

  const masterPlaylist = await masterResponse.text();

  // Parse the media playlist URL from master playlist
  const mediaPlaylistMatch = masterPlaylist.match(/^(?!#)(.+\.m3u8)$/m);
  if (!mediaPlaylistMatch) {
    throw new Error('Could not find media playlist URL in master playlist');
  }

  const mediaPlaylistUrl = new URL(mediaPlaylistMatch[1], env.EMBY_URL).toString();

  // Get media playlist
  const mediaResponse = await fetch(mediaPlaylistUrl, {
    headers: { 'X-Emby-Token': env.EMBY_API_KEY },
  });

  if (!mediaResponse.ok) {
    throw new Error(`Failed to get media playlist: ${mediaResponse.status}`);
  }

  const mediaPlaylist = await mediaResponse.text();

  // Parse segment URLs from media playlist
  const segmentUrls: string[] = [];
  const lines = mediaPlaylist.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith('#')) {
      const segmentUrl = new URL(line, mediaPlaylistUrl).toString();
      segmentUrls.push(segmentUrl);
    }
  }

  // Download and store segments
  const clipBasePath = `clips/${roomCode}/${roundNumber}`;
  const segmentNames: string[] = [];

  for (let i = 0; i < segmentUrls.length; i++) {
    const segmentResponse = await fetch(segmentUrls[i], {
      headers: { 'X-Emby-Token': env.EMBY_API_KEY },
    });

    if (!segmentResponse.ok) {
      throw new Error(`Failed to download segment ${i}: ${segmentResponse.status}`);
    }

    const segmentName = `segment_${i}.ts`;
    segmentNames.push(segmentName);

    const segmentBody = await segmentResponse.arrayBuffer();
    await env.CLIPS_BUCKET.put(`${clipBasePath}/${segmentName}`, segmentBody, {
      httpMetadata: { contentType: 'video/mp2t' },
    });
  }

  // Create and store the clip playlist
  const clipPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${duration}
#EXT-X-MEDIA-SEQUENCE:0
${segmentNames.map((name) => `#EXTINF:${duration},\n${name}`).join('\n')}
#EXT-X-ENDLIST`;

  await env.CLIPS_BUCKET.put(`${clipBasePath}/playlist.m3u8`, clipPlaylist, {
    httpMetadata: { contentType: 'application/vnd.apple.mpegurl' },
  });
}
