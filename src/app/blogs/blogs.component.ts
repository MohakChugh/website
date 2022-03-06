import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import * as axios from 'axios';
import { BackgroundBlogFetcherService } from '../background-blog-fetcher.service';

@Component({
  selector: 'app-blogs',
  templateUrl: './blogs.component.html',
  styleUrls: ['./blogs.component.css']
})
export class BlogsComponent implements OnInit {

  array: any;
  loading = false;
  constructor(
    private router: ActivatedRoute,
    private blogsFetcher: BackgroundBlogFetcherService
  ) { }

  ngOnInit(): void {
    this.loading = true;
    // If the blogs have already been loaded
    if (this.blogsFetcher.blogs.length === 0) {
      console.log('The blogs had to be loaded!');
      axios.default.get('https://website-backend-mohak.herokuapp.com/blogs')
        .then(res => {
          this.array = res.data.blogs;
          // tslint:disable-next-line: prefer-for-of
          for (let i = 0; i < this.array.length; i++) {
            this.array[i].link = 'https://mohakchugh.github.io/website/#/blog/' + this.array[i]._id;
          }
          this.loading = false;
        })
        .catch(err => console.log(err));
      // If the blogs have not been loaded
    } else {
      console.log('The blogs were already loaded!');
      this.array = this.blogsFetcher.blogs;
      this.loading = false;
    }
  }

  async getUrlParams() {
    this.router.queryParams.subscribe(res => {
      console.log(res);
    });
  }
}
