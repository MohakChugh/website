import { TestBed } from '@angular/core/testing';

import { BackgroundBlogFetcherService } from './background-blog-fetcher.service';

describe('BackgroundBlogFetcherService', () => {
  let service: BackgroundBlogFetcherService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(BackgroundBlogFetcherService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
