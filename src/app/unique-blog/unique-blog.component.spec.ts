import { async, ComponentFixture, TestBed } from '@angular/core/testing';

import { UniqueBlogComponent } from './unique-blog.component';

describe('UniqueBlogComponent', () => {
  let component: UniqueBlogComponent;
  let fixture: ComponentFixture<UniqueBlogComponent>;

  beforeEach(async(() => {
    TestBed.configureTestingModule({
      declarations: [ UniqueBlogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(UniqueBlogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
