import {
  Component,
  Input,
  OnChanges,
  OnInit,
  SimpleChanges
} from '@angular/core';
import { UntypedFormControl, UntypedFormGroup, Validators } from '@angular/forms';
import {
  BaseControlValueAccessor,
  createControlValueAccessorProviders
} from '../base-control-value-accessor';
import { AutocompleteOption } from '../autocomplete/autocomplete.component';

/**
 * data type used for this control
 */
export interface ObservationTestValue {
  observationDataType: string;
  testValuePrefix: string;
  testValueModifier: string;
  testValue: number | string;
  testValueUnit: string;
}

/**
 * Component for from/to date inputs combined together as one control
 */
@Component({
  selector: 'app-observation-test-value',
  templateUrl: './observation-test-value.component.html',
  styleUrls: ['./observation-test-value.component.less'],
  providers: createControlValueAccessorProviders(ObservationTestValueComponent)
})
export class ObservationTestValueComponent
  extends BaseControlValueAccessor<ObservationTestValue>
  implements OnInit, OnChanges {
  @Input() datatype: string;
  @Input() observationCodes: string[] = [];
  @Input() loincCodes: string[] = [];
  @Input() unitList: AutocompleteOption[];
  @Input() required = true;
  selectedDatatype = 'Quantity';
  testValueComparator = 'Quantity - ';
  form = new UntypedFormGroup({
    testValuePrefix: new UntypedFormControl(''),
    testValueModifier: new UntypedFormControl(''),
    testValue: new UntypedFormControl('', Validators.required),
    testValueUnit: new UntypedFormControl('')
  });
  // Mapping for supported value[x] properties of Observation
  readonly typeDescriptions = {
    Quantity: {
      searchValPrefixes: [
        // See https://www.hl7.org/fhir/search.html#prefix
        // if no prefix is present, the prefix 'eq' is assumed.
        ['=', ''],
        ['not equal', 'ne'],
        ['>', 'gt'],
        ['<', 'lt'],
        ['>=', 'ge'],
        ['<=', 'le']
      ],
      unit: true
    },
    CodeableConcept: {
      unit: false
    },
    String: {
      modifiers: [
        ['starts with', ''],
        ['contains', ':contains'],
        ['exact', ':exact']
      ],
      unit: false
    }
  };

  ngOnInit(): void {
    this.form.valueChanges.subscribe(() => {
      const formValue = this.form.getRawValue();
      if (!this.datatype) {
        // In case of "Variable Value" without "Variable Name", move value from 'testValueComparator' to construct the right query.
        formValue.testValuePrefix =
          (this.selectedDatatype === 'Quantity' &&
            this.testValueComparator.substr(11)) ||
          '';
        formValue.testValueModifier =
          (this.selectedDatatype === 'String' &&
            this.testValueComparator.substr(9)) ||
          '';
      }
      formValue.observationDataType = this.datatype || this.selectedDatatype;
      this.onChange(formValue);
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.datatype) {
      this.selectedDatatype = this.datatype || 'Quantity';
    }
    if (changes.required) {
      this.form
        .get('testValue')
        .setValidators(this.required ? Validators.required : null);
    }
  }

  /**
   * Part of the ControlValueAccessor interface
   */
  writeValue(value: ObservationTestValue): void {
    this.form.patchValue(
      value || {
        testValuePrefix: '',
        testValueModifier: '',
        testValue: '',
        testValueUnit: ''
      }
    );
    if (
      this.datatype &&
      !value?.testValueModifier &&
      this.typeDescriptions[this.datatype].modifiers &&
      this.typeDescriptions[this.datatype].modifiers.length === 1
    ) {
      // default and disable control if only one option
      this.form
        .get('testValueModifier')
        .setValue(this.typeDescriptions[this.datatype].modifiers[0][1]);
      this.form.get('testValueModifier').disable();
    }
    if (!this.datatype) {
      this.selectedDatatype = value.observationDataType || 'Quantity';
      // Write back to the composite Comparator control.
      if (this.selectedDatatype === 'Quantity') {
        this.testValueComparator = `${this.selectedDatatype} - ${value.testValuePrefix}`;
      } else if (this.selectedDatatype === 'String') {
        this.testValueComparator = `${this.selectedDatatype} - ${value.testValueModifier}`;
      }
    }
  }

  /**
   * This is called when user selects a comparator from the whole list of comparators ('testValueComparator' control).
   */
  setSelectedDatatype(value): void {
    this.selectedDatatype = value;
    this.form.get('testValue').setValue('');
    this.form.get('testValueUnit').setValue('');
  }
}
