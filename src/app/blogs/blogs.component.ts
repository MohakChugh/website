import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-blogs',
  templateUrl: './blogs.component.html',
  styleUrls: ['./blogs.component.css']
})
export class BlogsComponent implements OnInit {

  array = [1, 2, 3, 4, 5];
  constructor(private http: HttpClient) { }

  ngOnInit(): void {
    this.http.get('https://website-backend-mohak.herokuapp.com/blogs')
      .subscribe(Response => {
        console.log(Response);
      });
  }

}
