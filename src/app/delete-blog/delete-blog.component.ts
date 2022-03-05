import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import * as axios from 'axios';

@Component({
  selector: 'app-delete-blog',
  templateUrl: './delete-blog.component.html',
  styleUrls: ['./delete-blog.component.css']
})
export class DeleteBlogComponent implements OnInit {

  username: string;
  password: string;
  blogs: any;
  loading = false;
  constructor(private route: ActivatedRoute) { }

  ngOnInit(): void {
    this.username = this.route.snapshot.paramMap.get('username');
    this.password = this.route.snapshot.paramMap.get('password');
  
    axios.default.get('https://website-backend-mohak.herokuapp.com/blogs')
      .then(res => {
        this.blogs = res.data.blogs;
        // tslint:disable-next-line: prefer-for-of
        for (let i = 0; i < this.blogs.length; i++) {
          this.blogs[i].link = 'https://mohakchugh.github.io/website/#/blog/' + this.blogs[i]._id;
          this.blogs[i].username = this.username;
          this.blogs[i].password = this.password;
        }
        console.log(this.blogs);
        this.loading = false;
      })
      .catch(err => console.log(err));
  }

  deleteBlog(item: any): void {
    console.log(item);
    axios.default.post('https://website-backend-mohak.herokuapp.com/delete', {
      username: item.username,
      password: item.password,
      id: item._id
    })
      .then(response => console.log(response.data))
      .catch(err => console.log(err));
    
    axios.default.get('https://website-backend-mohak.herokuapp.com/blogs')
      .then(res => {
        this.blogs = res.data.blogs;
        // tslint:disable-next-line: prefer-for-of
        for (let i = 0; i < this.blogs.length; i++) {
          this.blogs[i].link = 'https://mohakchugh.github.io/website/#/blog/' + this.blogs[i]._id;
          this.blogs[i].username = this.username;
          this.blogs[i].password = this.password;
        }
        console.log(this.blogs);
        this.loading = false;
      })
      .catch(err => console.log(err));
  }


}
