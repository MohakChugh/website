import { async, ComponentFixture, TestBed } from '@angular/core/testing';

import { ContentPusherComponent } from './content-pusher.component';

describe('ContentPusherComponent', () => {
  let component: ContentPusherComponent;
  let fixture: ComponentFixture<ContentPusherComponent>;

  beforeEach(async(() => {
    TestBed.configureTestingModule({
      declarations: [ ContentPusherComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(ContentPusherComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
