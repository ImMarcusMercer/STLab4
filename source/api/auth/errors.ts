export class ApiError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly fields?: Record<string, string[]>) { super(message); }
}
