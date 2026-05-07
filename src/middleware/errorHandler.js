import { config } from '../config/env.js';

export function notFoundHandler(req, res) {
  res.status(404).send('Not found');
}

export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  console.error('[error]', req.method, req.originalUrl, '-', err.message);
  if (!config.isProduction) {
    console.error(err.stack);
  }
  if (res.headersSent) {
    return;
  }
  const message = config.isProduction
    ? 'Đã có lỗi xảy ra, vui lòng thử lại sau.'
    : `${err.message}\n\n${err.stack || ''}`;
  res.status(status).type('text/plain; charset=utf-8').send(message);
}
