import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import * as axios from 'axios';

@Component({
  selector: 'app-blogs',
  templateUrl: './blogs.component.html',
  styleUrls: ['./blogs.component.css']
})
export class BlogsComponent implements OnInit {

  array: any;
  loading = false;
  constructor(private router: ActivatedRoute) { }

  ngOnInit(): void {
    this.loading = true;
    axios.default.get('https://website-backend-mohak.herokuapp.com/blogs')
      .then(res => {
        this.array = res.data.blogs;
        // tslint:disable-next-line: prefer-for-of
        for (let i = 0; i < this.array.length; i++) {
          this.array[i].link = 'https://mohakchugh.github.io/website/#/blog/' + this.array[i]._id;
        }
        console.log(this.array);
        this.loading = false;
      })
      .catch(err => console.log(err));
  }

  async getUrlParams() {
    this.router.queryParams.subscribe(res => {
      console.log(res)
    })
  }
}
