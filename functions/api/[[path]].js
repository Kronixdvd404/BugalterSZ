import { handle } from '../../src/app.js';

// Все запросы /api/* обрабатывает один обработчик (маршруты описаны в src/app.js).
export const onRequest = ({ request, env }) => handle(request, env);
