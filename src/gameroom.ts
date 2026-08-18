import { Env, Player, Round, WSMessage } from './types';

const ROUND_TRANSITION_DELAY = 10000; // 10s reveal pause
const GUESS_WINDOW_DURATION = 20000; // 20s guessing window

function generateRoomCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export class GameRoom {
  private state: DurableObjectState;
  private env: Env;
  private players: Map<string, Player & { ws?: WebSocket }> = new Map();
  private displays: Set<WebSocket> = new Set();
  private currentRound: number = 0;
  private rounds: Round[] = [];
  private movieQueue: { id: string; name: string }[] = [];
  private roomCode: string = '';
  private gameStarted: boolean = false;
  private roundInProgress: boolean = false;
  private alarmScheduled: boolean = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.roomCode = this.state.id.toString().slice(0, 4).toUpperCase();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      return this.handleWebSocket(request);
    }

    if (url.pathname === '/code') {
      return new Response(JSON.stringify({ code: this.roomCode }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/state') {
      return new Response(
        JSON.stringify({
          roomCode: this.roomCode,
          currentRound: this.currentRound,
          players: Array.from(this.players.values()).map((p) => ({
            name: p.name,
            score: p.score,
            connected: p.connected,
          })),
          roundInProgress: this.roundInProgress,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.state.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let text: string;
    try {
      text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      const data = JSON.parse(text) as WSMessage;

      switch (data.type) {
        case 'join':
          await this.handleJoin(ws, data);
          break;
        case 'guess':
          await this.handleGuess(ws, data);
          break;
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.error('WS parse error:', error.message);
        this.sendToSocket(ws, { type: 'error', message: 'Invalid message format' });
      } else {
        console.error('WS handler error:', error);
        this.sendToSocket(ws, { type: 'error', message: String(error) });
      }
    }
  }

  private async handleJoin(ws: WebSocket, data: { role: 'display' | 'player'; name?: string }) {
    if (data.role === 'display') {
      this.displays.add(ws);
      this.sendToSocket(ws, {
        type: 'round_start',
        round: this.rounds[this.currentRound - 1] || ({} as Round),
        clipUrl: '',
      });
    } else if (data.role === 'player' && data.name) {
      // Check if player already exists (reconnection)
      let player = this.players.get(data.name);

      if (player) {
        // Reconnection - keep score
        player.connected = true;
        player.ws = ws;
      } else {
        // New player
        player = {
          name: data.name,
          score: 0,
          connected: true,
          ws,
        };
        this.players.set(data.name, player);
      }

      this.sendToSocket(ws, {
        type: 'scoreboard',
        players: Array.from(this.players.values()).map((p) => ({
          name: p.name,
          score: p.score,
        })),
      });

      // Auto-start game on first player join
      if (!this.gameStarted && this.players.size > 0) {
        this.gameStarted = true;
        this.startNewRound().catch((err) => {
          console.error('startNewRound failed:', err);
          this.sendToAll({ type: 'error', message: `Round failed: ${err.message}` });
          this.roundInProgress = false;
        });
      }
    }
  }

  private async handleGuess(ws: WebSocket, data: { guess: string }) {
    // Find which player sent this guess
    let playerName = '';
    for (const [name, player] of this.players) {
      if (player.ws === ws) {
        playerName = name;
        break;
      }
    }

    if (!playerName) {
      this.sendToSocket(ws, { type: 'error', message: 'You must join as a player first' });
      return;
    }

    const currentRoundData = this.rounds[this.currentRound - 1];
    if (!currentRoundData || currentRoundData.status !== 'playing') {
      this.sendToSocket(ws, { type: 'error', message: 'No active round' });
      return;
    }

    // Check if player already guessed
    if (currentRoundData.guesses.some((g) => g.playerName === playerName)) {
      this.sendToSocket(ws, { type: 'error', message: 'Already guessed this round' });
      return;
    }

    // Check if guess window is still open
    if (!currentRoundData.guessWindowStart) {
      this.sendToSocket(ws, { type: 'error', message: 'Guess window not open' });
      return;
    }

    const elapsed = Date.now() - currentRoundData.guessWindowStart;
    if (elapsed > GUESS_WINDOW_DURATION) {
      this.sendToSocket(ws, { type: 'error', message: 'Guess window closed' });
      return;
    }

    const correct = data.guess.toLowerCase().trim() === currentRoundData.movieName.toLowerCase().trim();

    currentRoundData.guesses.push({
      playerName,
      guess: data.guess,
      correct,
    });

    if (correct && !currentRoundData.winner) {
      currentRoundData.winner = playerName;
      const player = this.players.get(playerName);
      if (player) {
        player.score += 1;
      }
    }

    this.sendToSocket(ws, {
      type: 'guess_feedback',
      correct,
      guess: data.guess,
    });
  }

  private async startNewRound(): Promise<void> {
    if (this.roundInProgress) return;

    // Don't start round if no players connected
    const connectedPlayers = Array.from(this.players.values()).filter(p => p.connected);
    if (connectedPlayers.length === 0) {
      this.gameStarted = false;
      this.roundInProgress = false;
      return;
    }

    this.roundInProgress = true;
    this.currentRound++;
    console.log(`Starting round ${this.currentRound}...`);

    // Fetch next movie from queue or refill
    if (this.movieQueue.length === 0) {
      await this.fetchMovies();
    }

    // Try up to 5 movies if clip staging fails
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const movie = this.movieQueue.shift();
      if (!movie) {
        console.error('No movies available');
        this.sendToAll({ type: 'error', message: 'No movies available' });
        this.roundInProgress = false;
        return;
      }

      console.log(`Round ${this.currentRound} attempt ${attempt + 1}: ${movie.name} (${movie.id})`);

      const clipPath = `clips/${this.roomCode}/${this.currentRound}`;

      const round: Round = {
        number: this.currentRound,
        movieId: movie.id,
        movieName: movie.name,
        clipPath,
        status: 'staging',
        guesses: [],
      };

      this.rounds.push(round);

      try {
        await this.stageClip(movie.id, this.currentRound);
        round.status = 'playing';
        round.guessWindowStart = Date.now();

        this.sendToAll({
          type: 'round_start',
          round,
          clipUrl: `/clip/${this.roomCode}/${this.currentRound}/playlist.m3u8`,
          guessWindowDuration: GUESS_WINDOW_DURATION,
          revealDuration: ROUND_TRANSITION_DELAY,
        });

        await this.scheduleAlarm(GUESS_WINDOW_DURATION);
        return; // Success
      } catch (err) {
        console.error(`Failed to stage clip for round ${this.currentRound}:`, err);
        lastError = err as Error;
        // Remove the failed round
        this.rounds.pop();
      }
    }

    // All attempts failed
    this.sendToAll({ type: 'error', message: `Failed to load clip after 5 attempts: ${lastError?.message}` });
    this.roundInProgress = false;
  }

  private async endRound(): Promise<void> {
    const round = this.rounds[this.currentRound - 1];
    if (!round) return;

    round.status = 'revealing';

    // Broadcast round end
    this.sendToAll({
      type: 'round_end',
      winner: round.winner,
      correctAnswer: round.movieName,
    });

    // Broadcast updated scoreboard
    this.sendToAll({
      type: 'scoreboard',
      players: Array.from(this.players.values()).map((p) => ({
        name: p.name,
        score: p.score,
      })),
    });

    // After reveal pause, start next round
    await this.scheduleAlarm(ROUND_TRANSITION_DELAY);
  }

  private async scheduleAlarm(delayMs: number): Promise<void> {
    const alarmTime = Date.now() + delayMs;
    await this.state.storage.setAlarm(alarmTime);
    this.alarmScheduled = true;
  }

  async alarm(): Promise<void> {
    this.alarmScheduled = false;

    const currentRoundData = this.rounds[this.currentRound - 1];
    if (!currentRoundData) return;

    if (currentRoundData.status === 'playing') {
      await this.endRound();
    } else if (currentRoundData.status === 'revealing') {
      this.roundInProgress = false;
      // Only start next round if players are connected
      const connectedPlayers = Array.from(this.players.values()).filter(p => p.connected);
      if (connectedPlayers.length > 0) {
        await this.startNewRound();
      } else {
        this.gameStarted = false;
      }
    }
  }

  private async stageClip(movieId: string, roundNumber: number): Promise<void> {
    const duration = parseInt(this.env.CLIP_DURATION_SECONDS || '3');

    // Get media source ID
    console.log(`Fetching media source for ${movieId}...`);
    const itemResponse = await fetch(
      `${this.env.EMBY_URL}/Users/${this.env.EMBY_USER_ID}/Items/${movieId}?Fields=MediaSources`,
      { headers: { 'X-Emby-Token': this.env.EMBY_API_KEY }, signal: AbortSignal.timeout(15000) }
    );
    const itemData = await itemResponse.json() as { MediaSources?: Array<{ Id: string }> };
    const mediaSourceId = itemData.MediaSources?.[0]?.Id;

    if (!mediaSourceId) {
      throw new Error('No media source found for movie');
    }

    // Get HLS master playlist
    const playSessionId = crypto.randomUUID();
    const masterPlaylistUrl = `${this.env.EMBY_URL}/Videos/${movieId}/master.m3u8?MediaSourceId=${mediaSourceId}&Static=false&VideoCodec=h264&AudioCodec=aac&VideoBitRate=2000000&AudioBitRate=128000&MaxStreamingBitrate=2000000&StartTimeSeconds=0&PlaySessionId=${playSessionId}`;
    const masterResponse = await fetch(masterPlaylistUrl, {
      headers: { 'X-Emby-Token': this.env.EMBY_API_KEY },
    });

    if (!masterResponse.ok) {
      throw new Error(`Failed to get master playlist: ${masterResponse.status}`);
    }

    const masterPlaylist = await masterResponse.text();

    // Parse the media playlist URL from master playlist
    // Match non-comment lines that contain .m3u8 (with or without query params)
    const lines = masterPlaylist.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const playlistLine = lines.find(l => l.includes('.m3u8'));
    if (!playlistLine) {
      throw new Error(`Could not find media playlist URL in master playlist. Content: ${masterPlaylist.substring(0, 500)}`);
    }

    const mediaPlaylistUrl = new URL(playlistLine, masterPlaylistUrl).toString();

    // Get media playlist
    const mediaResponse = await fetch(mediaPlaylistUrl, {
      headers: { 'X-Emby-Token': this.env.EMBY_API_KEY },
    });

    if (!mediaResponse.ok) {
      const body = await mediaResponse.text();
      throw new Error(`Failed to get media playlist: ${mediaResponse.status} - URL: ${mediaPlaylistUrl} - Body: ${body.substring(0, 300)}`);
    }

    const mediaPlaylist = await mediaResponse.text();

    // Parse segment URLs from media playlist
    const segmentUrls: string[] = [];
    const segLines = mediaPlaylist.split('\n');
    for (let i = 0; i < segLines.length; i++) {
      const line = segLines[i].trim();
      if (line && !line.startsWith('#')) {
        const segmentUrl = new URL(line, mediaPlaylistUrl).toString();
        segmentUrls.push(segmentUrl);
      }
    }

    console.log('Master playlist URL:', masterPlaylistUrl);
    console.log('Media playlist URL:', mediaPlaylistUrl);
    console.log(`Total segments available: ${segmentUrls.length}`);

    // Only download segments needed for clip duration
    const neededSegments = Math.ceil(duration / 6) + 1;
    // Pick a random offset into the segment list to get a random part of the movie
    const maxOffset = Math.max(segmentUrls.length - neededSegments - 1, 0);
    const offset = maxOffset > 0 ? Math.floor(Math.random() * maxOffset) : 0;
    const segmentsToFetch = segmentUrls.slice(offset, offset + Math.max(neededSegments, 1));
    console.log(`Downloading ${segmentsToFetch.length} segments from offset ${offset}/${segmentUrls.length} (need ${duration}s clip)`);

    // Download and store segments
    const clipBasePath = `clips/${this.roomCode}/${roundNumber}`;
    const segmentNames: string[] = [];

    for (let i = 0; i < segmentsToFetch.length; i++) {
      const segmentResponse = await fetch(segmentsToFetch[i], {
        headers: { 'X-Emby-Token': this.env.EMBY_API_KEY },
        signal: AbortSignal.timeout(15000),
      });

      if (!segmentResponse.ok) {
        const body = await segmentResponse.text();
        throw new Error(`Failed to download segment ${i}: ${segmentResponse.status} - URL: ${segmentsToFetch[i]} - Body: ${body.substring(0, 200)}`);
      }

      const segmentName = `segment_${i}.ts`;
      segmentNames.push(segmentName);

      const segmentBody = await segmentResponse.arrayBuffer();
      await this.env.CLIPS_BUCKET.put(`${clipBasePath}/${segmentName}`, segmentBody, {
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

    await this.env.CLIPS_BUCKET.put(`${clipBasePath}/playlist.m3u8`, clipPlaylist, {
      httpMetadata: { contentType: 'application/vnd.apple.mpegurl' },
    });
  }

  private async fetchMovies(): Promise<void> {
    console.log('Fetching movies from Emby...');
    const response = await fetch(
      `${this.env.EMBY_URL}/Users/${this.env.EMBY_USER_ID}/Items?IncludeItemTypes=Movie&Recursive=true&Fields=Id,Name&Limit=50`,
      {
        headers: {
          'X-Emby-Token': this.env.EMBY_API_KEY,
        },
        signal: AbortSignal.timeout(15000),
      }
    );
    console.log('Movies response:', response.status);

    if (response.ok) {
      const data = await response.json() as { Items?: Array<{ Id: string; Name: string }> };
      this.movieQueue = (data.Items || []).map((item) => ({
        id: item.Id,
        name: item.Name,
      }));
      console.log(`Got ${this.movieQueue.length} movies`);
      // Shuffle the queue
      for (let i = this.movieQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.movieQueue[i], this.movieQueue[j]] = [this.movieQueue[j], this.movieQueue[i]];
      }
    }
  }

  private sendToSocket(ws: WebSocket, message: WSMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      // Client disconnected
    }
  }

  private sendToAll(message: WSMessage): void {
    const data = JSON.stringify(message);

    // Send to displays
    for (const ws of this.displays) {
      try {
        ws.send(data);
      } catch (error) {
        this.displays.delete(ws);
      }
    }

    // Send to players
    for (const [name, player] of this.players) {
      if (player.ws && player.connected) {
        try {
          player.ws.send(data);
        } catch (error) {
          player.connected = false;
        }
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    // Remove from displays
    this.displays.delete(ws);

    // Mark player as disconnected
    for (const [name, player] of this.players) {
      if (player.ws === ws) {
        player.connected = false;
        break;
      }
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // Handle error
    console.error('WebSocket error:', error);
  }
}
