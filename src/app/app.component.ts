import { Component } from '@angular/core';
import { BackgroundBlogFetcherService } from './background-blog-fetcher.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {
  title = 'portfolio';

  constructor(private blogsFetcher: BackgroundBlogFetcherService) { }
}
