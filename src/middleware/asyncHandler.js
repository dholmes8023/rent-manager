/**
 * Wraps an async route handler so any rejected promise reaches Express's
 * error handling middleware instead of becoming an unhandled rejection.
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
