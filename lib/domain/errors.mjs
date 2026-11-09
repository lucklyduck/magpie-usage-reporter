export class AppError extends Error {
  constructor(
    message,
    status = 400,
    code = "invalid_input",
    details = undefined,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export function invariant(ok, message, code = "invalid_input") {
  if (!ok) throw new AppError(message, 400, code);
}
export const clone = (value) => structuredClone(value);
export function failure(error) {
  return {
    message: error?.message || "操作失败",
    code: error?.code || "internal_error",
    ...(error?.details ? { details: error.details } : {}),
  };
}
