import {
  AfterViewInit,
  Component,
  Input,
  OnChanges,
  OnDestroy,
  QueryList,
  SimpleChanges,
  ViewChildren
} from '@angular/core';
import { map, startWith } from 'rxjs/operators';
import {
  ConnectionStatus,
  FhirBackendService
} from '../../shared/fhir-backend/fhir-backend.service';
import { Observable, Subscription } from 'rxjs';
import { ColumnDescriptionsService } from '../../shared/column-descriptions/column-descriptions.service';
import { FormControl, UntypedFormControl, Validators } from '@angular/forms';
import { SearchParameterGroupComponent } from '../search-parameter-group/search-parameter-group.component';
import { SelectedObservationCodes } from '../../types/selected-observation-codes';
import { PullDataService } from '../../shared/pull-data/pull-data.service';
import { getPluralFormOfResourceType } from '../../shared/utils';
import { ResourceTableParentComponent } from '../resource-table-parent.component';
import { SearchParameterGroup } from '../../types/search-parameter-group';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { CohortService } from '../../shared/cohort/cohort.service';
import { ColumnValuesService } from '../../shared/column-values/column-values.service';
import {
  ResourceTableComponent,
  TableRow
} from '../resource-table/resource-table.component';

/**
 * The main component for pulling Patient-related resources data
 */
@Component({
  selector: 'app-pull-data-page',
  templateUrl: './pull-data-page.component.html',
  styleUrls: [
    './pull-data-page.component.less',
    '../resource-table/resource-table.component.less'
  ]
})
export class PullDataPageComponent
  extends ResourceTableParentComponent
  implements OnChanges, AfterViewInit, OnDestroy {
  // Default observation codes for the "Pull data for the cohort" step
  @Input()
  defaultObservationCodes: SelectedObservationCodes;

  // Array of visible resource type names
  visibleResourceTypes: string[];
  // Array of not visible resource type names
  unselectedResourceTypes: string[];
  // Array of resource type names that has "code text" search parameter
  codeTextResourceTypes: string[] = [];
  // Subscription to the loading process
  loadSubscription: Subscription;

  // This observable is used to avoid ExpressionChangedAfterItHasBeenCheckedError
  // when the active tab changes
  currentResourceType$: Observable<string>;

  // Form controls of 'per patient' input
  perPatientFormControls: { [resourceType: string]: UntypedFormControl } = {};
  // Number of recent Observations per Patient to load when no code is specified
  // in the criteria.
  maxObservationToCheck = new FormControl<number>(1000, [
    Validators.required,
    Validators.min(1)
  ]);
  // Whether any Observation code is added to the Observation criteria
  isObsCodesSelected = false;
  // Form controls of SearchParameterGroupComponents
  parameterGroups: {
    [resourceType: string]: FormControl<SearchParameterGroup>;
  } = {};
  // Selected Observation codes
  pullDataObservationCodes: Map<string, string> = null;

  private _isVariablePatientTable = false;
  // Columns for the Variable-Patient table
  variablePatientTableColumns: string[] = [];
  // DataSource for the Variable-Patient table
  variablePatientTableDataSource: TableRow[] = [];
  @ViewChildren(ResourceTableComponent)
  resourceTables: QueryList<ResourceTableComponent>;

  constructor(
    private fhirBackend: FhirBackendService,
    public columnDescriptions: ColumnDescriptionsService,
    public cohort: CohortService,
    public pullData: PullDataService,
    private liveAnnouncer: LiveAnnouncer,
    private columnValues: ColumnValuesService
  ) {
    super();
    fhirBackend.initialized
      .pipe(map((status) => status === ConnectionStatus.Ready))
      .subscribe((connected) => {
        this.visibleResourceTypes = ['Observation'];
        this.unselectedResourceTypes = [];
        if (connected) {
          const resources = fhirBackend.getCurrentDefinitions().resources;
          this.unselectedResourceTypes = Object.keys(resources).filter(
            (resourceType) =>
              this.visibleResourceTypes.indexOf(resourceType) === -1
          );
          this.codeTextResourceTypes = Object.entries(resources)
            .filter((r: [string, any]) =>
              r[1].searchParameters.some((sp) => sp.element === 'code text')
            )
            .map((r) => r[0]);
        }

        []
          .concat(this.visibleResourceTypes, this.unselectedResourceTypes)
          .forEach((resourceType) => {
            // Due to optimization, we cannot control the number of ResearchStudies
            // per Patient. Luckily it doesn't make much sense.
            if (
              resourceType !== 'ResearchStudy' &&
              resourceType !== 'Patient'
            ) {
              const defaultCount =
                resourceType === 'EvidenceVariable' ||
                resourceType === 'Observation'
                  ? 1
                  : 1000;
              this.perPatientFormControls[
                resourceType
              ] = new UntypedFormControl(defaultCount, [
                Validators.required,
                Validators.min(1)
              ]);
            }
            this.parameterGroups[
              resourceType
            ] = new FormControl<SearchParameterGroup>({
              resourceType,
              parameters: []
            });
          });

        this.isObsCodesSelected = false;
        this.parameterGroups.Observation.valueChanges.subscribe((value) => {
          const isObsCodesSelected =
            value.parameters[0]?.selectedObservationCodes?.items.length > 0;
          if (isObsCodesSelected !== this.isObsCodesSelected) {
            this.liveAnnouncer.announce(
              isObsCodesSelected
                ? 'The input field for the maximum number of recent Observations per Patient to check has disappeared.'
                : 'A new input field for the maximum number of recent Observations per Patient to check has appeared above.'
            );
          }
          this.isObsCodesSelected = isObsCodesSelected;
        });
      });
  }

  /**
   * Returns plural form of resource type name.
   */
  getPluralFormOfResourceType = getPluralFormOfResourceType;

  ngAfterViewInit(): void {
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
  }

  ngOnDestroy(): void {
    this.loadSubscription?.unsubscribe();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.defaultObservationCodes) {
      this.updateObservationCodesWithDefaults();
    }
  }

  /**
   * Sets the default observation codes to the appropriate autocomplete field.
   * @private
   */
  private updateObservationCodesWithDefaults(): void {
    if (this.defaultObservationCodes) {
      this.isObsCodesSelected = this.defaultObservationCodes.items.length > 0;
      this.parameterGroups['Observation'].setValue({
        resourceType: 'Observation',
        parameters: [
          {
            element: 'code text',
            selectedObservationCodes: this.defaultObservationCodes
          }
        ]
      });
    }
  }

  /**
   * Whether to show code selection after Load button.
   */
  showCodeSelection(resourceType: string): boolean {
    // TODO: waiting feedback from Clem whether we will show code selection for all
    // resource types with a "code text" search parameter.
    return resourceType === 'Observation';
    // return this.codeTextResourceTypes.includes(resourceType);
  }

  /**
   * Adds tab for specified resource type.
   */
  addTab(resourceType: string): void {
    this.unselectedResourceTypes.splice(
      this.unselectedResourceTypes.indexOf(resourceType),
      1
    );
    this.visibleResourceTypes.push(resourceType);
    this.tabGroup.selectedIndex = this.visibleResourceTypes.length - 1;
    if (resourceType === 'Observation') {
      // Update the default observation codes for the newly created Observation tab.
      this.updateObservationCodesWithDefaults();
    }
  }

  /**
   * Returns text for the remove tab button.
   */
  getRemoveTabButtonText(resourceType: string): string {
    return `Remove ${getPluralFormOfResourceType(resourceType)} tab`;
  }

  /**
   * Removes tab for specified resource type.
   */
  removeTab(resourceType: string): void {
    this.unselectedResourceTypes.push(resourceType);
    this.unselectedResourceTypes.sort();
    const removeIndex = this.visibleResourceTypes.indexOf(resourceType);
    if (removeIndex && removeIndex === this.tabGroup.selectedIndex) {
      this.tabGroup.selectedIndex--;
    }
    this.visibleResourceTypes.splice(removeIndex, 1);
  }

  /**
   * Opens a dialog for configuring resource table columns.
   */
  configureColumns(): void {
    this.columnDescriptions.openColumnsDialog(
      this.getCurrentResourceType(),
      'pull-data'
    );
  }

  /**
   * Loads resources of the specified type for a cohort of Patients.
   * @param resourceType - resource type
   * @param parameterGroup - component for managing search parameters of the resource type
   */
  loadResources(
    resourceType: string,
    parameterGroup: SearchParameterGroupComponent
  ): void {
    if (parameterGroup.hasErrors()) {
      parameterGroup.showErrors();
      return;
    }
    this.loadSubscription?.unsubscribe();
    if (resourceType === 'Observation') {
      // If in Variable-Patient table mode, reset to normal Observation table mode.
      this._isVariablePatientTable = false;
      // Clear Variable-Patient table dataSource which was built from the previous
      // Observation table data.
      this.variablePatientTableDataSource.length = 0;
    }

    if (resourceType === 'Observation') {
      const selectedObservationCodes = parameterGroup.getSearchParamValues()[0]
        .selectedObservationCodes;
      this.pullDataObservationCodes = new Map();
      selectedObservationCodes.coding?.forEach((c, i) => {
        this.pullDataObservationCodes.set(
          c.code,
          selectedObservationCodes.items[i]
        );
      });
    }

    this.loadSubscription = this.pullData
      .loadResources(
        resourceType,
        this.perPatientFormControls[resourceType]?.value || 1000,
        // TODO: simplify by using observationParameterGroup
        parameterGroup.getConditions().criteria,
        this.maxObservationToCheck.value
      )
      .subscribe();
  }

  /**
   * Check if the input controls on the tab for the specified resource type have
   * valid values.
   * @param resourceType - resource type
   */
  isValidTab(resourceType: string): boolean {
    return (
      (!this.perPatientFormControls[resourceType] ||
        this.perPatientFormControls[resourceType].valid) &&
      (resourceType !== 'Observation' ||
        this.parameterGroups['Observation'].value.parameters[0]
          ?.selectedObservationCodes.items.length > 0 ||
        this.maxObservationToCheck.valid)
    );
  }

  /**
   * Get an object to be saved into sessionStorage before RAS re-login.
   */
  getReloginStatus(): any[] {
    return this.visibleResourceTypes.map((r) => {
      const tabInfo = {
        resourceType: r,
        perPatientFormControls: this.perPatientFormControls[r]?.value,
        parameterGroups: this.parameterGroups[r].value
      };
      if (r === 'Observation') {
        tabInfo['maxObservationToCheck'] = this.maxObservationToCheck.value;
      }
      return tabInfo;
    });
  }

  /**
   * Restore opened resource tabs and related form controls
   * @param restoreStatus an object constructed from getReloginStatus() method.
   */
  restoreLoginStatus(restoreStatus: any[]): void {
    let hasObservationTab = false;
    restoreStatus.forEach((x) => {
      if (x.resourceType === 'Observation') {
        hasObservationTab = true;
        this.maxObservationToCheck.setValue(x.maxObservationToCheck);
      } else {
        this.addTab(x.resourceType);
      }
      this.perPatientFormControls[x.resourceType]?.setValue(
        x.perPatientFormControls
      );
      this.parameterGroups[x.resourceType].setValue(x.parameterGroups);
    });
    if (!hasObservationTab) {
      this.removeTab('Observation');
    }
  }

  /**
   * Property to indicate whether to show the Variable-Patient table or the normal
   * resource table.
   */
  get isVariablePatientTable(): boolean {
    return this._isVariablePatientTable;
  }
  set isVariablePatientTable(value: boolean) {
    if (value && !this.variablePatientTableDataSource.length) {
      this.buildVariablePatientTableData();
    }
    this._isVariablePatientTable = value;
  }

  /**
   * Construct the dataSource for the Variable-Patient table from the Observation table.
   * It is called if user switch to Variable-Patient table after the Observation table is
   * fully loaded. It uses cell data from the Observation table, so they don't need to be
   * calculated again.
   */
  buildVariablePatientTableData(): void {
    const observationResourcetableComponent = this.resourceTables.find(
      (rt) => rt.resourceType === 'Observation'
    );
    const observationTableData =
      observationResourcetableComponent.dataSource.data;
    this.variablePatientTableColumns = ['Patient'].concat(
      Array.from(
        new Set(
          // "Variable Name" (codeText) column values from the Observation table are used
          // as column headers in the Variable-Patient table.
          observationTableData.map((tableRow) => tableRow.cells['codeText'])
        )
      )
    );
    // A map of patient to variable data required for the Variable-Patient table.
    const variablePatientMap = new Map();
    observationTableData.forEach((tableRow) => {
      if (!variablePatientMap.has(tableRow.cells['subject'])) {
        variablePatientMap.set(tableRow.cells['subject'], {
          Patient: tableRow.cells['subject']
        });
      }
      variablePatientMap.get(tableRow.cells['subject'])[
        tableRow.cells['codeText']
      ] = tableRow.cells['value[x]'];
    });
    this.variablePatientTableDataSource = Array.from(
      variablePatientMap,
      (x) =>
        ({
          cells: x[1]
        } as TableRow)
    );
  }
}
