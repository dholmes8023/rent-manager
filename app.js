import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import methodOverride from 'method-override';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';

import { config } from './src/config/env.js';
import { migrate } from './db.js';
import healthRoutes from './src/routes/health.routes.js';
import settingsRoutes from './src/routes/settings.routes.js';
import roomsRoutes from './src/routes/rooms.routes.js';
import invoiceRoutes from './src/routes/invoice.routes.js';
import { errorHandler, notFoundHandler } from './src/middleware/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp() {
  const app = express();

  // Security & operational middleware. CSP is relaxed because the views load
  // Tailwind from a CDN and use small inline scripts.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(compression());
  app.use(morgan(config.isProduction ? 'combined' : 'dev'));

  app.use(express.urlencoded({ extended: true }));
  app.use(methodOverride('_method'));
  app.use('/public', express.static(path.join(__dirname, 'public')));

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(healthRoutes);
  app.use(roomsRoutes);
  app.use(settingsRoutes);
  app.use(invoiceRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

async function main() {
  try {
    await migrate();
  } catch (err) {
    console.error('[startup] Database migration failed:', err);
    process.exit(1);
  }

  const app = createApp();
  app.listen(config.PORT, () => {
    console.log(`[startup] Rent Manager listening on port ${config.PORT} (${config.NODE_ENV})`);
  });
}

main();
