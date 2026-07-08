import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RevealDirective } from '../../shared/reveal.directive';
import { ScrollFillDirective } from '../../shared/motion/scroll-fill.directive';

@Component({
  selector: 'app-stats',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RevealDirective, ScrollFillDirective],
  templateUrl: './stats.html',
})
export class Stats {}
