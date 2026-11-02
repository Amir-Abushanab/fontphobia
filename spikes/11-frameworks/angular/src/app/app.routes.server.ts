import { RenderMode, ServerRoute } from '@angular/ssr';

export const serverRoutes: ServerRoute[] = [
  {
    path: 'posts/:id',
    renderMode: RenderMode.Prerender,
    async getPrerenderParams() {
      return [{ id: '1' }, { id: '2' }];
    }
  },
  {
    path: '**',
    renderMode: RenderMode.Prerender
  }
];
