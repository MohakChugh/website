import { async, ComponentFixture, TestBed } from '@angular/core/testing';

import { SocialMediaAccordianComponent } from './social-media-accordian.component';

describe('SocialMediaAccordianComponent', () => {
  let component: SocialMediaAccordianComponent;
  let fixture: ComponentFixture<SocialMediaAccordianComponent>;

  beforeEach(async(() => {
    TestBed.configureTestingModule({
      declarations: [ SocialMediaAccordianComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(SocialMediaAccordianComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
