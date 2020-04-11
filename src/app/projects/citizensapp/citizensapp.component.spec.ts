import { async, ComponentFixture, TestBed } from '@angular/core/testing';

import { CitizensappComponent } from './citizensapp.component';

describe('CitizensappComponent', () => {
  let component: CitizensappComponent;
  let fixture: ComponentFixture<CitizensappComponent>;

  beforeEach(async(() => {
    TestBed.configureTestingModule({
      declarations: [ CitizensappComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(CitizensappComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
