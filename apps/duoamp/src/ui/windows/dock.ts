import { APP_NAME } from '../../config';
import type { WinComponent } from '../context';
import { h } from '../dom';

/**
 * Blank chassis panel with an embossed logo. Fills a pane region that would
 * otherwise be empty (e.g. playlist hidden in a two-pane posture).
 */
export class DockWindow implements WinComponent {
  readonly el: HTMLElement;
  constructor() {
    this.el = h('section', 'win win-dock', [h('div', 'dock-logo', APP_NAME), h('div', 'dock-grille')], { 'aria-hidden': 'true' });
  }
  layout() {}
}
