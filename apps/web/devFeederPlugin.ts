import type { Plugin } from 'vite';
import { createFeederHandler } from '../../scripts/lib/feederHandler.ts';

export function devFeederPlugin(config: {
  uri: string;
  database: string;
}): Plugin {
  return {
    name: 'sync-dev-feeder',
    apply: 'serve',
    configureServer(server) {
      const feeder = createFeederHandler(config);
      server.httpServer?.once('close', () => feeder.close());
      server.middlewares.use('/__dev/feed', (req, res) => {
        if (
          req.headers.origin &&
          req.headers.origin !== `http://${req.headers.host}` &&
          req.headers.origin !== `https://${req.headers.host}`
        ) {
          res.statusCode = 403;
          res.end(
            JSON.stringify({
              error: 'Cross-origin feeder requests are not allowed.',
            }),
          );
          return;
        }
        feeder.handle(req, res);
      });
    },
  };
}
