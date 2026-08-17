export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  CLIPS_BUCKET: R2Bucket;
  EMBY_URL: string;
  EMBY_USER_ID: string;
  EMBY_API_KEY: string;
  CLIP_QUEUE_DEPTH: string;
  CLIP_DURATION_SECONDS: string;
}

export interface Player {
  name: string;
  score: number;
  connected: boolean;
  ws?: WebSocket;
}

export interface Round {
  number: number;
  movieId: string;
  movieName: string;
  clipPath: string;
  status: 'staging' | 'playing' | 'revealing' | 'completed';
  guessWindowStart?: number;
  guesses: { playerName: string; guess: string; correct: boolean }[];
  winner?: string;
}

export interface GameState {
  roomCode: string;
  currentRound: number;
  players: Map<string, Player>;
  rounds: Round[];
  movieQueue: { id: string; name: string }[];
  lastActivity: number;
}

export type WSMessage =
  | { type: 'join'; role: 'display' | 'player'; name?: string }
  | { type: 'guess'; guess: string }
  | { type: 'round_start'; round: Round; clipUrl: string }
  | { type: 'round_end'; winner?: string; correctAnswer: string }
  | { type: 'scoreboard'; players: { name: string; score: number }[] }
  | { type: 'timer'; secondsLeft: number }
  | { type: 'error'; message: string };
