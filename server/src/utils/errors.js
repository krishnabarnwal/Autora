/**
 * HTTP error helper.
 *
 * app.js's final error handler reads `status` and `code`, and only forwards the
 * message to the client for 4xx. Throwing these from a route keeps validation
 * failures declarative instead of littering handlers with res.status().json().
 */
export function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export const badRequest = (code, message) => httpError(400, code, message);
export const notFound = (code, message) => httpError(404, code, message);
