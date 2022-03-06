import { Injectable } from '@angular/core';
import * as axios from 'axios';

@Injectable({
  providedIn: 'root'
})
export class BackgroundBlogFetcherService {

  blogs: any = [];
  constructor() {
    axios.default.get('https://website-backend-mohak.herokuapp.com/blogs')
      .then(res => {
        this.blogs = res.data.blogs;
        // tslint:disable-next-line: prefer-for-of
        for (let i = 0; i < this.blogs.length; i++) {
          this.blogs[i].link = 'https://mohakchugh.github.io/website/#/blog/' + this.blogs[i]._id;
        }
      })
      .catch(err => console.log(err));
  }
}
