import 'dotenv/config';
import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST?.trim() || '127.0.0.1';

app.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
});
