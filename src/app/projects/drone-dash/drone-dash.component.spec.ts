import { async, ComponentFixture, TestBed } from '@angular/core/testing';

import { DroneDashComponent } from './drone-dash.component';

describe('DroneDashComponent', () => {
  let component: DroneDashComponent;
  let fixture: ComponentFixture<DroneDashComponent>;

  beforeEach(async(() => {
    TestBed.configureTestingModule({
      declarations: [ DroneDashComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(DroneDashComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
