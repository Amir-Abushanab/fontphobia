import { Routes } from '@angular/router';
import { Home } from './pages/home';
import { About } from './pages/about';
import { Post } from './pages/post';

export const routes: Routes = [
  { path: '', component: Home },
  { path: 'about', component: About },
  { path: 'posts/:id', component: Post },
];
