import dotenv from 'dotenv';

dotenv.config();

const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT) || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';

if (!DATABASE_URL) {
  console.warn(
    '[config] DATABASE_URL is not set. The app will fail to start without a Postgres connection string.'
  );
}

export const config = Object.freeze({
  NODE_ENV,
  PORT,
  DATABASE_URL,
  isProduction: NODE_ENV === 'production',
});
