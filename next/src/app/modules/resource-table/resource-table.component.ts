import {
  AfterViewInit,
  Component,
  Input,
  NgZone,
  OnChanges,
  OnInit,
  SimpleChanges,
  ViewChild
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SelectionModel } from '@angular/cdk/collections';
import { FormBuilder, FormControl, FormGroup } from '@angular/forms';
import { MatTableDataSource } from '@angular/material/table';
import Bundle = fhir.Bundle;
import BundleEntry = fhir.BundleEntry;
import { ColumnDescription } from '../../types/column.description';
import { debounceTime } from 'rxjs/operators';
import { CdkScrollable } from '@angular/cdk/overlay';
import { FhirBackendService } from '../../shared/fhir-backend/fhir-backend.service';
import { capitalize } from '../../shared/utils';

/**
 * Component for loading table of resources
 */
@Component({
  selector: 'app-resource-table',
  templateUrl: './resource-table.component.html',
  styleUrls: ['./resource-table.component.less']
})
export class ResourceTableComponent
  implements OnInit, AfterViewInit, OnChanges {
  @Input() columnDescriptions: ColumnDescription[];
  @Input() initialBundle: Bundle;
  @Input() enableClientFiltering = false;
  @Input() enableSelection = false;
  @Input() max = 0;
  columns: string[] = [];
  filterColumns = [];
  nextBundleUrl: string;
  selectedResources = new SelectionModel<BundleEntry>(true, []);
  filtersForm: FormGroup = new FormBuilder().group({});
  dataSource = new MatTableDataSource<BundleEntry>([]);
  lastResourceElement: HTMLElement;
  isLoading = false;
  @ViewChild(CdkScrollable) scrollable: CdkScrollable;
  resourceTotal = 0;

  constructor(
    private http: HttpClient,
    private ngZone: NgZone,
    private fhirBackend: FhirBackendService
  ) {}

  ngOnInit(): void {
    this.dataSource.data = this.initialBundle.entry;
    this.nextBundleUrl = this.initialBundle.link.find(
      (l) => l.relation === 'next'
    )?.url;
    this.resourceTotal = this.initialBundle.total;
  }

  /**
   * Use columns present in bundle info as default, if empty column descriptions is passed in
   */
  private setColumnsFromBundle(): void {
    // TODO: hard coded Patient
    const allColumns = this.fhirBackend.getColumns('Patient');
    this.columnDescriptions = allColumns.filter((x) =>
      this.getCellDisplay(this.initialBundle.entry[0], x)
    );
    // Save column selections of default
    window.localStorage.setItem(
      // TODO: resource type binding
      'Patient-columns',
      this.columnDescriptions.map((x) => x.element).join(',')
    );
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['columnDescriptions']) {
      this.columns.length = 0;
      if (this.enableSelection) {
        this.columns.push('select');
      }
      if (!this.columnDescriptions.length) {
        this.setColumnsFromBundle();
      }
      this.columns = this.columns.concat(
        this.columnDescriptions.map((c) => c.element)
      );
      if (this.enableClientFiltering) {
        this.filtersForm = new FormBuilder().group({});
        this.filterColumns = this.columns.map((c) => c + 'Filter');
        this.columnDescriptions.forEach((column) => {
          this.filtersForm.addControl(column.element, new FormControl());
        });
        this.dataSource.filterPredicate = ((data, filter) => {
          for (const [key, value] of Object.entries(filter)) {
            if (value) {
              const columnDescription = this.columnDescriptions.find(
                (c) => c.element === key
              );
              const cellValue = this.getCellDisplay(data, columnDescription);
              if (
                !cellValue
                  .toLowerCase()
                  .startsWith((value as string).toLowerCase())
              ) {
                return false;
              }
            }
          }
          return true;
          // casting method signature here because filterPredicate defines filter param as string
          // tslint:disable-next-line:variable-name
        }) as (BundleEntry, string) => boolean;
        this.filtersForm.valueChanges.subscribe((value) => {
          this.dataSource.filter = { ...value } as string;
        });
      }
    }
  }

  ngAfterViewInit(): void {
    this.scrollable
      .elementScrolled()
      .pipe(debounceTime(700))
      .subscribe((e) => {
        this.ngZone.run(() => {
          this.onTableScroll(e);
        });
      });
  }

  /**
   * Call and load a bundle of resources
   */
  callBatch(url: string): void {
    this.isLoading = true;
    this.nextBundleUrl = '';
    this.http.get(url).subscribe((data: Bundle) => {
      this.isLoading = false;
      // If max is defined, load no more than max number of resource rows
      if (
        this.max &&
        this.dataSource.data.length + data.entry.length > this.max
      ) {
        return;
      }
      this.nextBundleUrl = data.link.find((l) => l.relation === 'next')?.url;
      this.dataSource.data = this.dataSource.data.concat(data.entry);
    });
  }

  /**
   * Table viewport scroll handler
   */
  onTableScroll(e): void {
    // Extra safeguard in case server traffic takes longer than scroll throttle time (1000ms)
    if (!this.nextBundleUrl) {
      return;
    }
    const tableViewHeight = e.target.offsetHeight; // viewport: 300px
    const tableScrollHeight = e.target.scrollHeight; // length of all table
    const scrollLocation = e.target.scrollTop; // how far user scrolled
    // If the user has scrolled within 200px of the bottom, add more data
    const buffer = 200;
    const limit = tableScrollHeight - tableViewHeight - buffer;
    if (scrollLocation > limit) {
      this.callBatch(this.nextBundleUrl);
    }
  }

  /** Whether the number of selected elements matches the total number of rows. */
  isAllSelected(): boolean {
    const numSelected = this.selectedResources.selected.length;
    const numRows = this.dataSource.data.length;
    return numSelected === numRows;
  }

  /** Selects all rows if they are not all selected; otherwise clear selection. */
  masterToggle(): void {
    this.isAllSelected()
      ? this.selectedResources.clear()
      : this.dataSource.data.forEach((row) =>
          this.selectedResources.select(row)
        );
  }

  /**
   * Clear filters on all columns
   */
  clearColumnFilters(): void {
    this.filtersForm.reset();
  }

  /**
   * Get cell display
   */
  getCellDisplay(row: BundleEntry, column: ColumnDescription): string {
    if (column.types.length === 1) {
      return this.getCellDisplayByType(row, column.types[0], column.element);
    }
    for (const type of column.types) {
      const output = this.getCellDisplayByType(
        row,
        type,
        column.element.replace('[x]', capitalize(type))
      );
      if (output) {
        return output;
      }
    }
    return '';
  }

  /**
   * Get cell display by type
   */
  getCellDisplayByType(
    row: BundleEntry,
    type: string,
    element: string
  ): string {
    switch (type) {
      case 'Address':
        return this.getAddressDisplay(row.resource['address']);
      case 'HumanName':
        return this.humanNameToString(row.resource['name']);
      default:
        return row.resource[element];
    }
  }

  /**
   * Get address display
   */
  getAddressDisplay(addressElements): string {
    for (const address of addressElements) {
      if (address['text']) {
        return address['text'];
      }
    }
    return '';
  }

  /**
   * Get name display
   */
  humanNameToString(nameElements): string {
    let rtn;
    const name = nameElements && nameElements[0];

    if (name) {
      // tslint:disable-next-line:one-variable-per-declaration
      const given = name.given || [],
        firstName = given[0] || '',
        lastName = name.family || '';
      let middleName = given[1] || '';

      if (middleName.length === 1) {
        middleName += '.';
      }
      rtn = [firstName, middleName, lastName].filter((item) => item).join(' ');
    }

    return rtn || null;
  }

  /**
   * Get count message according to total/max number of resources
   */
  get countMessage(): string {
    let output = '';
    if (this.enableSelection) {
      output += `Selected ${this.selectedResources.selected.length} out of `;
    }
    if (!this.resourceTotal && !this.max) {
      output += `${this.dataSource.data.length} rows loaded.`;
    }
    if (!this.resourceTotal && this.max) {
      output += `${this.max} maximum rows.`;
    }
    if (this.resourceTotal && !this.max) {
      output += `${this.resourceTotal} total rows.`;
    }
    if (this.resourceTotal && this.max) {
      output +=
        this.max > this.resourceTotal
          ? `${this.resourceTotal} total rows.`
          : `${this.max} maximum rows.`;
    }
    return output;
  }
}
