import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  OnInit,
  ViewChild
} from '@angular/core';
import { FormControl, Validators } from '@angular/forms';
import {
  ConnectionStatus,
  FhirBackendService
} from '../../shared/fhir-backend/fhir-backend.service';
import { map, startWith } from 'rxjs/operators';
import { Observable, Subject } from 'rxjs';
import { MatTabChangeEvent, MatTabGroup } from '@angular/material/tabs';
import { ColumnDescriptionsService } from '../../shared/column-descriptions/column-descriptions.service';
import Resource = fhir.Resource;
import { ResourceTableComponent } from '../resource-table/resource-table.component';
import { SelectRecordsService } from '../../shared/select-records/select-records.service';

@Component({
  selector: 'app-select-records-page',
  templateUrl: './select-records-page.component.html',
  styleUrls: ['./select-records-page.component.less']
})
export class SelectRecordsPageComponent implements OnInit, AfterViewInit {
  @ViewChild(MatTabGroup) tabGroup: MatTabGroup;
  @ViewChild('researchStudyTable') researchStudyTable: ResourceTableComponent;
  @ViewChild('variableTable') variableTable: ResourceTableComponent;
  maxPatientsNumber = new FormControl('100', Validators.required);

  // Array of visible resource type names
  visibleResourceTypes: string[];
  // Map a resource type to a tab name
  resourceType2TabName = {
    ResearchStudy: 'Study'
  };
  // Array of not visible resource type names
  unselectedResourceTypes: string[];
  // This observable is used to avoid ExpressionChangedAfterItHasBeenCheckedError
  // when the active tab changes
  currentResourceType$: Observable<string>;
  variablesStream: Subject<Resource>;

  constructor(
    private fhirBackend: FhirBackendService,

    public columnDescriptions: ColumnDescriptionsService,
    private cdr: ChangeDetectorRef,
    public selectRecords: SelectRecordsService
  ) {
    fhirBackend.initialized
      .pipe(map((status) => status === ConnectionStatus.Ready))
      .subscribe((connected) => {
        this.visibleResourceTypes = fhirBackend.features.hasResearchStudy
          ? ['ResearchStudy', 'Variable']
          : ['Observation'];
        this.unselectedResourceTypes = [];
        if (connected) {
          const resources = fhirBackend.getCurrentDefinitions().resources;
          this.unselectedResourceTypes = Object.keys(resources).filter(
            (resourceType) =>
              this.visibleResourceTypes.indexOf(resourceType) === -1
          );
        }
      });
  }

  ngOnInit(): void {}

  ngAfterViewInit(): void {
    setTimeout(() => {
      this.currentResourceType$ = this.tabGroup.selectedTabChange.pipe(
        startWith(this.getCurrentResourceType()),
        map(() => {
          // Dispatching a resize event fixes the issue with <cdk-virtual-scroll-viewport>
          // displaying an empty table when the active tab is changed.
          // This event runs _changeListener in ViewportRuler which run checkViewportSize
          // in CdkVirtualScrollViewport.
          // See code for details:
          // https://github.com/angular/components/blob/12.2.3/src/cdk/scrolling/viewport-ruler.ts#L55
          // https://github.com/angular/components/blob/12.2.3/src/cdk/scrolling/virtual-scroll-viewport.ts#L184
          if (typeof Event === 'function') {
            // fire resize event for modern browsers
            window.dispatchEvent(new Event('resize'));
          } else {
            // for IE and other old browsers
            // causes deprecation warning on modern browsers
            const evt = window.document.createEvent('UIEvents');
            // @ts-ignore
            evt.initUIEvent('resize', true, false, window, 0);
            window.dispatchEvent(evt);
          }
          return this.getCurrentResourceType();
        })
      );

      const resourceType = this.visibleResourceTypes[0];
      this.selectRecords.loadFirstPage(
        resourceType,
        `$fhir/${resourceType}?_count=50`
      );

      // this.selectRecords.loadFirstPage(
      //   'ResearchStudy',
      //   '$fhir/ResearchStudy?_count=50&_total=accurate'
      // );
    });
  }

  /**
   * Returns text for the remove tab button.
   */
  getRemoveTabButtonText(resourceType: string): string {
    return `Remove ${this.getPluralFormOfResourceType(resourceType)} tab`;
  }

  /**
   * Returns plural form of resource type name.
   */
  getPluralFormOfResourceType(resourceType: string): string {
    const tabName = this.resourceType2TabName[resourceType] || resourceType;
    return tabName.replace(/(.*)(.)/, (_, $1, $2) => {
      if ($2 === 'y') {
        return $1 + 'ies';
      }
      return _ + 's';
    });
  }

  /**
   * Returns resourceType for the selected tab
   */
  getCurrentResourceType(): string {
    return this.visibleResourceTypes[this.tabGroup.selectedIndex];
  }

  /**
   * Handles changing the selected tab.
   * @param event - tab change event
   */
  selectedTabChange(event: MatTabChangeEvent): void {
    const resourceType = this.visibleResourceTypes[event.index];
    if (!this.selectRecords.currentState[resourceType]) {
      if (resourceType === 'Variable') {
        this.filterVariables();
      } else {
        this.selectRecords.loadFirstPage(
          resourceType,
          `$fhir/${resourceType}?_count=50&_total=accurate`
        );
      }
    }
  }

  /**
   * Applies the variable table filter change.
   */
  filterVariables(): void {
    this.variablesStream = new Subject<Resource>();
    this.cdr.detectChanges();
    this.selectRecords.loadVariables(
      this.researchStudyTable.selectedResources.selected,
      this.variableTable?.filtersForm.value || {}
    );
  }
}
