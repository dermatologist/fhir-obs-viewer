import { Directive, HostListener, Optional } from '@angular/core';
import { MatAutocompleteTrigger } from '@angular/material/autocomplete';

@Directive({
  // tslint:disable-next-line:directive-selector
  selector: '[tabToSelect]'
})
export class TabToSelectDirective {
  observable: any;
  constructor(@Optional() private autoTrigger: MatAutocompleteTrigger) {}

  @HostListener('keydown.tab', ['$event.target']) onTab(): void {
    if (this.autoTrigger.activeOption) {
      this.autoTrigger._onChange(this.autoTrigger.activeOption.value);
    }
  }
}
