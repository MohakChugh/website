import { async, ComponentFixture, TestBed } from '@angular/core/testing';

import { FarmersappComponent } from './farmersapp.component';

describe('FarmersappComponent', () => {
  let component: FarmersappComponent;
  let fixture: ComponentFixture<FarmersappComponent>;

  beforeEach(async(() => {
    TestBed.configureTestingModule({
      declarations: [ FarmersappComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(FarmersappComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
