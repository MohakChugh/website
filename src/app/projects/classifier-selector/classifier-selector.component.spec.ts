import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ClassifierSelectorComponent } from './classifier-selector.component';

describe('ClassifierSelectorComponent', () => {
  let component: ClassifierSelectorComponent;
  let fixture: ComponentFixture<ClassifierSelectorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ ClassifierSelectorComponent ]
    })
    .compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(ClassifierSelectorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
