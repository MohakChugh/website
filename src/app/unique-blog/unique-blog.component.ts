import { Component, OnInit } from '@angular/core';
import * as axios from 'axios';
import { ActivatedRoute } from '@angular/router';

@Component({
  selector: 'app-unique-blog',
  templateUrl: './unique-blog.component.html',
  styleUrls: ['./unique-blog.component.css']
})
export class UniqueBlogComponent implements OnInit {

  array: any;
  loading = false;
  id: any;
  constructor(private route: ActivatedRoute) { }

  ngOnInit(): void {
    this.loading = true;
    this.id = this.route.snapshot.paramMap.get('id');
    console.log(this.id);
    axios.default.get('https://website-backend-mohak.herokuapp.com/blog/' + this.id)
      .then(res => {
        console.log(res.data.blog);
        this.array = [res.data.blog];
        console.log(this.array);
        this.loading = false;
      })
      .catch(err => console.log(err));
  }

}
