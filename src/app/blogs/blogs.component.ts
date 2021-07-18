import { Component, OnInit } from '@angular/core';
import * as axios from 'axios';

@Component({
  selector: 'app-blogs',
  templateUrl: './blogs.component.html',
  styleUrls: ['./blogs.component.css']
})
export class BlogsComponent implements OnInit {

  array: any;
  loading = false;
  constructor() { }

  ngOnInit(): void {
    this.loading = true;
    axios.default.get('https://website-backend-mohak.herokuapp.com/blogs')
      .then(res => {
        this.array = res.data.blogs;
        console.log(this.array);
        this.loading = false;
      })
      .catch(err => console.log(err));
  }
}
