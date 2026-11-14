import { handleApi } from './api';
import { runCleanup, runIngestion } from './ingest';
import { Env } from './types';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env, ctx);
    // 静的アセット（PWA）。セキュリティヘッダは public/_headers で付与
    return env.ASSETS.fetch(req);
  },

  async scheduled(ctrl: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cron は 1 本だけ（アカウント全体で無料枠 5 本のため、他の Worker の枠を圧迫しない）
    const t = new Date(ctrl.scheduledTime);
    const jobs: Promise<unknown>[] = [runIngestion(env, ctrl.scheduledTime)];
    if (t.getUTCHours() === 0 && t.getUTCMinutes() === 0) jobs.push(runCleanup(env, ctrl.scheduledTime));
    ctx.waitUntil(Promise.allSettled(jobs));
    await Promise.allSettled(jobs);
  },
} satisfies ExportedHandler<Env>;
