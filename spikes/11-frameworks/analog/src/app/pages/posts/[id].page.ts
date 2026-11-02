import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

@Component({
  selector: 'app-post',
  template: `<h1>Post {{ id }}</h1>`,
})
export default class PostPage {
  protected readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id');
}
