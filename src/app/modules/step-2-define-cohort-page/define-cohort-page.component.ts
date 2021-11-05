import { Component, OnInit, ViewChild } from '@angular/core';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  ValidationErrors,
  Validators
} from '@angular/forms';
import {
  BaseControlValueAccessorAndValidator,
  createControlValueAccessorAndValidatorProviders
} from '../base-control-value-accessor';
import { SearchParametersComponent } from '../search-parameters/search-parameters.component';
import {
  BehaviorSubject,
  EMPTY,
  forkJoin,
  from,
  Observable,
  of,
  OperatorFunction,
  Subject
} from 'rxjs';
import Resource = fhir.Resource;
import { FhirBackendService } from '../../shared/fhir-backend/fhir-backend.service';
import { HttpClient } from '@angular/common/http';
import { ErrorManager } from '../../shared/error-manager/error-manager.service';
import {
  catchError,
  concatMap,
  expand,
  filter,
  finalize,
  map,
  mergeMap,
  share,
  startWith,
  switchMap,
  take,
  tap
} from 'rxjs/operators';
import Bundle = fhir.Bundle;
import { QueryParamsService } from '../../shared/query-params/query-params.service';
import { getNextPageUrl } from '../../shared/utils';
import {
  Criteria,
  Criterion,
  ResourceTypeCriteria
} from '../../types/search-parameters';
import { uniqBy } from 'lodash-es';
// Patient resource type name
const PATIENT_RESOURCE_TYPE = 'Patient';
// ResearchStudy resource type name
const RESEARCH_STUDY_RESOURCE_TYPE = 'ResearchStudy';
// ResearchSubject resource type name
const RESEARCH_SUBJECT_RESOURCE_TYPE = 'ResearchSubject';

/**
 * Component for defining criteria to build a cohort of Patient resources.
 */
@Component({
  selector: 'app-define-cohort-page',
  templateUrl: './define-cohort-page.component.html',
  styleUrls: ['./define-cohort-page.component.less'],
  providers: [
    ...createControlValueAccessorAndValidatorProviders(
      DefineCohortPageComponent
    ),
    ErrorManager
  ]
})
export class DefineCohortPageComponent
  extends BaseControlValueAccessorAndValidator<any>
  implements OnInit {
  defineCohortForm: FormGroup;
  // Observable that emits Patient resources that match the criteria
  patientStream: Observable<Resource>;
  // Number of matched Patients
  patientCount = 0;
  // Processed Patient Ids used to skip already selected Patients
  processedPatientIds: { [patientId: string]: boolean };
  // The number of resources in processing is used to pause the loading of the next page
  numberOfProcessingResources$: BehaviorSubject<number>;
  // A matrix of loading info that will be displayed with View Cohort resource table.
  loadingStatistics: (string | number)[][] = [];

  @ViewChild('patientParams') patientParams: SearchParametersComponent;

  constructor(
    private formBuilder: FormBuilder,
    private fhirBackend: FhirBackendService,
    private http: HttpClient,
    private errorManager: ErrorManager,
    private queryParams: QueryParamsService
  ) {
    super();
  }

  ngOnInit(): void {
    this.defineCohortForm = this.formBuilder.group({
      maxPatientsNumber: ['100', Validators.required]
    });
    this.defineCohortForm.valueChanges.subscribe((value) => {
      this.onChange(value);
    });
  }

  validate({ value }: FormControl): ValidationErrors | null {
    return this.defineCohortForm.get('maxPatientsNumber').errors;
  }

  writeValue(obj: any): void {}

  /**
   * Returns a prepared criteria tree:
   *  - removes empty subgroups from criteria tree
   *  - adds root criteria for selected ResearchStudies if necessary
   */
  prepareCriteria(
    criteria: Criteria | ResourceTypeCriteria,
    researchStudyIds: string[] = null
  ): Criteria | ResourceTypeCriteria | null {
    // When we have selected research studies, we load associated Patients
    // and check them with criteria:
    if (researchStudyIds?.length) {
      return {
        condition: 'and',
        rules: ([
          {
            condition: 'and',
            resourceType: PATIENT_RESOURCE_TYPE,
            rules: [
              {
                field: {
                  // The case when an element is not a search parameter is
                  // specially taken into account in the function getQueryParam
                  // of the service QueryParamsService.
                  element: '_has:ResearchSubject:individual:study',
                  value: researchStudyIds.join(',')
                }
              }
            ]
          }
        ] as Array<Criteria | ResourceTypeCriteria>).concat(
          this.prepareCriteria(criteria) || []
        )
      } as Criteria;
    }

    if ('resourceType' in criteria) {
      // Return the criteria for the resource type as is
      return criteria;
    } else {
      // Remove empty subgroups so we don't have to consider them in the search algorithm
      const rules = criteria.rules.reduce((result, rule) => {
        const preparedRule = this.prepareCriteria(rule);
        if (preparedRule) {
          result.push(preparedRule);
        }
        return result;
      }, []);
      if (rules.length === 0) {
        return null;
      } else {
        return {
          ...criteria,
          rules
        };
      }
    }
  }

  /**
   * Search for a list of Patient resources using the criteria tree.
   * This method searches from the server and checks Patient resources
   * against all criteria, and emits Patient resources that match criteria
   * through {patientStream}
   */
  searchForPatients(researchStudyIds: string[] = null): void {
    // Maximum number of Patients to load
    const maxPatientCount = this.defineCohortForm.value.maxPatientsNumber;
    const emptyPatientCriteria: ResourceTypeCriteria = {
      condition: 'and',
      resourceType: PATIENT_RESOURCE_TYPE,
      rules: []
    };

    // Preprocess a criteria tree built using the Query Builder component.
    // If there are no criteria - use default empty Patient criteria.
    const criteria = (this.prepareCriteria(
      this.patientParams.queryBuilderComponent.data as Criteria,
      researchStudyIds
    ) || emptyPatientCriteria) as Criteria;

    // Reset the number of matched Patients
    this.patientCount = 0;
    this.processedPatientIds = {};
    this.numberOfProcessingResources$ = new BehaviorSubject<number>(0);

    // Create a new Observable which emits Patient resources that match the criteria.
    // If we have only one block with Patient criteria - load all Patient in one request.
    this.patientStream = this.search(
      criteria,
      this.isOnlyOneBlockWithPatientCriteria(criteria)
        ? maxPatientCount
        : this.getPageSize()
    ).pipe(
      // Expand each array of resources into separate resources
      concatMap((resources) => from(resources)),
      // Skip already processed Patients
      filter((resource) => {
        const patientId = this.getPatientIdFromResource(resource);
        if (this.processedPatientIds[patientId]) {
          // Update the number of resources in processing
          this.numberOfProcessingResources$.next(
            this.numberOfProcessingResources$.value - 1
          );
          return false;
        }
        this.processedPatientIds[patientId] = true;
        return true;
      }),
      // Stop emitting resources when the maximum number is reached
      take(maxPatientCount),
      // If the found resource isn't a Patient (when no criteria for Patients),
      // replace it with a Patient
      mergeMap((resource) => {
        if (resource.resourceType === PATIENT_RESOURCE_TYPE) {
          return of(resource);
        }

        // The check function replaces the resource with the Patient resource
        // if there are criteria for the patient
        return this.check(resource, emptyPatientCriteria);
      }),
      tap(() => {
        // Increment the number of matched Patients
        this.patientCount++;
        if (this.patientCount < maxPatientCount) {
          // Update the number of resources in processing
          this.numberOfProcessingResources$.next(
            this.numberOfProcessingResources$.value - 1
          );
        } else {
          // Cancel the loading of the next page if the maximum number of
          // Patients has been reached
          this.numberOfProcessingResources$.next(0);
          this.numberOfProcessingResources$.complete();
        }
      }),
      // Complete observable on error
      catchError(() => EMPTY),
      // Do not create a new stream for each subscription
      share()
    );
  }

  /**
   * Checks for errors
   */
  hasErrors(): boolean {
    return this.errorManager.errors !== null || this.defineCohortForm.invalid;
  }

  /**
   * Shows errors for existing formControls
   */
  showErrors(): void {
    this.errorManager.showErrors();
  }

  /**
   * Returns optimal page size for requesting resources.
   */
  getPageSize(): number {
    // The value (maxRequestsPerBatch*maxActiveRequests*2) is the "optimal" page
    // size to get resources for filtering/mapping. This value should be so
    // minimal as not to load a lot of unnecessary data, but sufficient to allow
    // parallel loading of data to speed up the process.
    return (
      this.fhirBackend.maxRequestsPerBatch *
      this.fhirBackend.maxActiveRequests *
      2
    );
  }

  /**
   * Returns an Observable that emits arrays of resources (page by page) that
   * match the criteria. If among the criteria there are criteria for Patients,
   * then the Observable will emit arrays of Patient resources.
   * @param criteria - criteria tree
   * @param pageSize - the value of the _count parameter
   */
  search(
    criteria: Criteria | ResourceTypeCriteria,
    pageSize: number
  ): Observable<Resource[]> {
    const maxPatientCount = this.defineCohortForm.value.maxPatientsNumber;

    // Loading resources by criteria for specified resource type
    if ('resourceType' in criteria) {
      // If the resource criteria are combined by the OR operator, we split them
      // into separate ones. ANDed criteria will be sent in one request.
      return from(
        criteria.condition === 'or'
          ? criteria.rules.map((rule) => [rule])
          : [criteria.rules]
      ).pipe(
        // Sequentially execute queries and put the result into the stream.
        concatMap((rules) =>
          this.requestResources(
            criteria.resourceType,
            rules,
            pageSize,
            maxPatientCount
          )
        )
      );
      // Loading a subgroup of resources by criteria combined by the OR operator
    } else if (criteria.condition === 'or') {
      return from(criteria.rules).pipe(
        concatMap((rule) => this.search(rule, pageSize))
      );
    } else {
      // Loading a subgroup of resources by criteria combined by the AND operator
      if (criteria.rules.length > 1) {
        // Get new criteria sorted by the number of matching resources.
        return this.getAmountOfResources(criteria).pipe(
          mergeMap((newCriteria) => {
            // If there are no matching resources, return an empty result
            if (newCriteria.total === 0) {
              return from([]);
            }
            // All child criteria except the first one
            const restRules = newCriteria.rules.slice(1);
            // Search by the first child criterion
            return this.search(newCriteria.rules[0], pageSize).pipe(
              mergeMap((resources: Resource[]) => {
                // Exclude processed and duplicate resources
                const uncheckedResources = (uniqBy(
                  resources,
                  this.getPatientIdFromResource
                ) as Resource[]).filter(
                  (resource) =>
                    !this.processedPatientIds[
                      this.getPatientIdFromResource(resource)
                    ]
                );

                // Run a parallel check of the accumulated resources by the rest
                // of the criteria:
                return (uncheckedResources.length
                  ? forkJoin(
                      uncheckedResources.map((resource) =>
                        this.check(resource, {
                          ...newCriteria,
                          rules: restRules
                        }).pipe(startWith(null as Resource))
                      )
                    )
                  : of([])
                ).pipe(
                  map((r: Resource[]) => {
                    const checkedResources = r.filter((resource) => !!resource);
                    // Update the number of resources in processing
                    this.numberOfProcessingResources$.next(
                      this.numberOfProcessingResources$.value -
                        (resources.length - checkedResources.length)
                    );
                    return checkedResources;
                  })
                );
              })
            );
          })
        );
      } else {
        return this.search(criteria.rules[0], pageSize);
      }
    }
  }

  /**
   * Checks if the Patient related to the specified resource meets the specified
   * criteria. Returns an Observable that emits resource that match the criteria.
   * If among the criteria there are criteria for Patients or the input resource
   * is the Patient, then the Observable will emit Patient resource.
   */
  check(
    resource: Resource,
    criteria: Criteria | ResourceTypeCriteria
  ): Observable<Resource> {
    const patientId = this.getPatientIdFromResource(resource);

    if ('resourceType' in criteria) {
      // If the resource criteria are combined by the OR operator, we split them
      // into separate ones. ANDed criteria will be sent in one request.
      return from(
        criteria.condition === 'or'
          ? criteria.rules.map((rule) => [rule])
          : [criteria.rules]
      ).pipe(
        // Sequentially execute queries and put the result into the stream
        concatMap((rules) => {
          const useHas = this.canUseHas(criteria.resourceType, rules);
          const resourceType = useHas
            ? PATIENT_RESOURCE_TYPE
            : criteria.resourceType;
          // If the resource is not a Patient, we extract only the subject
          // element in order to further identify the Patient by it.
          const elements =
            (resourceType === RESEARCH_STUDY_RESOURCE_TYPE &&
              '&_elements=individual') ||
            (resourceType !== PATIENT_RESOURCE_TYPE && '&_elements=subject') ||
            '';

          const link =
            (resourceType === PATIENT_RESOURCE_TYPE && `_id=${patientId}`) ||
            (resourceType === RESEARCH_STUDY_RESOURCE_TYPE &&
              `_count=1&&_has:ResearchSubject:study:individual=Patient/${patientId}`) ||
            `_count=1&subject:Patient=${patientId}`;
          const query =
            `$fhir/${resourceType}?${link}${elements}` +
            rules
              .map((criterion: Criterion) => {
                const urlParamString = this.queryParams.getQueryParam(
                  criteria.resourceType,
                  criterion.field
                );
                return useHas
                  ? urlParamString.replace(
                      /&/g,
                      `&_has:${criteria.resourceType}:subject:`
                    )
                  : urlParamString;
              })
              .join('');
          return this.http.get<Bundle>(query).pipe(
            map((response) => {
              if (!response?.entry?.length) {
                return null;
              }
              return response.entry[0].resource.resourceType ===
                PATIENT_RESOURCE_TYPE
                ? response.entry[0].resource
                : resource;
            })
          );
        }),
        // If the resource criteria are combined by the OR operator, we will
        // take the first matched resource:
        filter((r) => r !== null),
        take(1)
      );
    } else if (criteria.condition === 'or') {
      return from(criteria.rules).pipe(
        concatMap((rule) => this.check(resource, rule)),
        filter((r) => r !== null),
        take(1)
      );
    } else {
      if (criteria.rules.length > 1) {
        return forkJoin(
          criteria.rules.map((rule) =>
            this.check(resource, rule).pipe(startWith(null as Resource))
          )
        ).pipe(
          map((resources) => {
            if (resources.indexOf(null) !== -1) {
              return null;
            }
            const pat = resources.find(
              (r) => r.resourceType === PATIENT_RESOURCE_TYPE
            );
            return pat || resource;
          })
        );
      } else {
        return this.check(resource, criteria.rules[0]);
      }
    }
  }

  /**
   * Extracts the Patient ID from a patient-related resource or from a Patient
   * resource.
   */
  getPatientIdFromResource(resource: Resource): string {
    return resource.resourceType === PATIENT_RESOURCE_TYPE
      ? resource.id
      : /^Patient\/(.*)/.test((resource as any).subject.reference) && RegExp.$1;
  }

  /**
   * Returns the criteria tree sorted at each level by the total amount of
   * patient-related resources that match these criteria and populates the total
   * property for each resource criteria and resource subgroup.
   * This helps to find the best way to select Patients and get rid of
   * unnecessary searches.
   */
  getAmountOfResources(criteria: Criteria): Observable<Criteria> {
    if ('total' in criteria) {
      return of(criteria);
    }

    return (criteria.rules.length
      ? forkJoin(
          criteria.rules.map((ruleset) => {
            if ('resourceType' in ruleset) {
              // If the resource criteria are combined by the OR operator, we split them
              // into separate ones. ANDed criteria will be sent in one request.
              const rulesets =
                ruleset.condition === 'or'
                  ? ruleset.rules.map((rule) => [rule])
                  : [ruleset.rules];
              return forkJoin(
                rulesets.map((rules) =>
                  this.requestAmountOfResources(ruleset.resourceType, rules)
                )
              ).pipe(
                map((totals) => ({
                  ...ruleset,
                  total: totals.reduce((total, totalN) => total + totalN, 0)
                }))
              );
            } else {
              return this.getAmountOfResources(ruleset);
            }
          })
        )
      : of([])
    ).pipe(
      map((rules) => {
        const sortedRules =
          criteria.condition === 'and'
            ? rules.sort((x, y) => x.total - y.total)
            : rules;

        return {
          condition: criteria.condition,
          rules: sortedRules,
          total:
            criteria.condition === 'and'
              ? sortedRules[0].total
              : sortedRules.reduce((total, rule) => total + rule.total, 0)
        };
      })
    );
  }

  /**
   * Returns true if the _has query can be used to retrieve Patient resources
   * based on the specified criteria for specified resource type.
   */
  canUseHas(
    resourceType: string,
    criteriaForResourceType: Array<Criterion>
  ): boolean {
    // We can use _has to select Patients if we only have one
    // criterion for the resource type:
    return (
      resourceType !== PATIENT_RESOURCE_TYPE &&
      resourceType !== RESEARCH_STUDY_RESOURCE_TYPE &&
      criteriaForResourceType.length === 1 &&
      this.queryParams
        .getQueryParam(resourceType, criteriaForResourceType[0].field)
        .lastIndexOf('&') === 0
    );
  }

  /**
   * Returns true if the specified criteria has only one resource type criteria
   * block with Patient criteria.
   */
  isOnlyOneBlockWithPatientCriteria(
    criteria: Criteria | ResourceTypeCriteria
  ): boolean {
    if ('resourceType' in criteria) {
      return criteria.resourceType === PATIENT_RESOURCE_TYPE;
    } else {
      const oneResourceCriteria =
        criteria.rules.length === 1 && 'resourceType' in criteria.rules[0]
          ? criteria.rules[0]
          : false;
      return (
        oneResourceCriteria &&
        (oneResourceCriteria.resourceType === PATIENT_RESOURCE_TYPE ||
          this.canUseHas(
            oneResourceCriteria.resourceType,
            oneResourceCriteria.rules
          ))
      );
    }
  }

  /**
   * Requests the number of patient-related resources that match the specified
   * array of criteria. For ResearchStudy, requests the number of ResearchSubjects
   * for the first 100 ResearchStudies that have ResearchSubjects.
   * @param resourceType - resource type
   * @param rules - array of ANDed criteria
   */
  requestAmountOfResources(
    resourceType: string,
    rules: Criterion[]
  ): Observable<number> {
    const hasResearchSubjects = this.getHasResearchSubjectsParam();
    const useHas = this.canUseHas(resourceType, rules);

    const query =
      '$fhir/' +
      (useHas ? PATIENT_RESOURCE_TYPE : resourceType) +
      (resourceType === RESEARCH_STUDY_RESOURCE_TYPE
        ? '?_element=id&_count=100' + hasResearchSubjects
        : '?_total=accurate&_summary=count') +
      rules
        .map((criterion: Criterion) => {
          const urlParamString = this.queryParams.getQueryParam(
            resourceType,
            criterion.field
          );
          return useHas
            ? urlParamString.replace(/&/g, `&_has:${resourceType}:subject:`)
            : urlParamString;
        })
        .join('');

    return this.http.get<Bundle>(query).pipe(
      concatMap((response) => {
        if (resourceType === RESEARCH_STUDY_RESOURCE_TYPE) {
          const researchStudyIds = response.entry
            ?.map(({ resource }) => resource.id)
            .join(',');
          return researchStudyIds
            ? this.requestAmountOfResources(RESEARCH_SUBJECT_RESOURCE_TYPE, [
                {
                  field: {
                    element: 'study',
                    value: researchStudyIds
                  }
                },
                {
                  field: {
                    element: '_total',
                    value: 'accurate'
                  }
                },
                {
                  field: {
                    element: '_summary',
                    value: 'count'
                  }
                }
              ])
            : of(0);
        }
        return of(response.total);
      })
    );
  }

  /**
   * Requests resources related to Patient (or Patient resources) by criteria.
   * @param resourceType - resource type
   * @param rules - array of ANDed criteria
   * @param pageSize - page size
   * @param maxPatientCount - maximum number of Patients to load
   */
  requestResources(
    resourceType: string,
    rules: Criterion[],
    pageSize: number,
    maxPatientCount: number
  ): Observable<Resource[]> {
    // Returns an empty Observable if the maximum number of patients has been reached
    if (this.patientCount >= maxPatientCount) {
      return EMPTY;
    }

    // For ResearchStudy criteria, we requests ResearchStudies and then
    // recursively requests Patients for those ResearchStudies:
    if (resourceType === RESEARCH_STUDY_RESOURCE_TYPE) {
      const nextResearchStudyPage$ = new Subject<void>();
      const hasResearchSubjects = this.getHasResearchSubjectsParam();

      return this.http
        .get<Bundle>(
          `$fhir/${resourceType}?_count=${pageSize}&_elements=id${hasResearchSubjects}` +
            rules.map((criterion: Criterion) =>
              this.queryParams.getQueryParam(resourceType, criterion.field)
            )
        )
        .pipe(
          // Modifying the Observable to load the following pages sequentially
          this.loadPagesSequentially(maxPatientCount, nextResearchStudyPage$),
          // Expand the BundleEntries array into separate resources
          concatMap((response) => {
            return from((response?.entry || []).map((i) => i.resource)).pipe(
              concatMap((res) => {
                return this.requestResources(
                  PATIENT_RESOURCE_TYPE,
                  [
                    {
                      field: {
                        element: '_has:ResearchSubject:individual:study',
                        value: `ResearchStudy/${res.id}`
                      }
                    }
                  ],
                  pageSize,
                  maxPatientCount
                );
              }),
              finalize(() => {
                nextResearchStudyPage$.next();
              })
            );
          })
        );
    }

    const useHas = this.canUseHas(resourceType, rules);
    const queryResourceType = useHas ? PATIENT_RESOURCE_TYPE : resourceType;
    // If the resource is not a Patient, we extract only the subject
    // element in order to further identify the Patient by it.
    const elements =
      queryResourceType !== PATIENT_RESOURCE_TYPE ? '&_elements=subject' : '';
    const query =
      `$fhir/${queryResourceType}?_count=${pageSize}${elements}` +
      rules
        .map((criterion: Criterion) => {
          const urlParamString = this.queryParams.getQueryParam(
            resourceType,
            criterion.field
          );
          return useHas
            ? urlParamString.replace(/&/g, `&_has:${resourceType}:subject:`)
            : urlParamString;
        })
        .join('');

    return this.http.get<Bundle>(query).pipe(
      // Modifying the Observable to load the following pages sequentially
      this.loadPagesSequentially(
        maxPatientCount,
        this.numberOfProcessingResources$.pipe(
          // Waiting for processing of already loaded resources
          filter(
            (numberOfProcessingResources) => numberOfProcessingResources === 0
          )
        )
      ),
      // Expand the BundleEntries array into separate resources
      map((response: Bundle) => {
        const resources = (response?.entry || []).map((i) => i.resource);
        // Update the number of resources in processing
        this.numberOfProcessingResources$.next(
          this.numberOfProcessingResources$.value + resources.length
        );
        return resources;
      })
    );
  }

  /**
   * Modifies the Observable to load the following pages sequentially
   * @param maxPatientCount - maximum number of Patients to load
   * @param readyForNextPage - the next page request will be executed after this
   *   Observable emits a value.
   */
  loadPagesSequentially(
    maxPatientCount: number,
    readyForNextPage: Observable<any>
  ): OperatorFunction<Bundle, Bundle> {
    return expand((response: Bundle) => {
      const nextPageUrl = getNextPageUrl(response);
      if (!nextPageUrl) {
        // Emit a complete notification if there is no next page
        return EMPTY;
      }
      // Do not load next page before processing current page
      return readyForNextPage.pipe(
        // Load each page once
        take(1),
        switchMap(() => {
          if (this.patientCount < maxPatientCount) {
            // Load the next page of resources
            return this.http.get<Bundle>(nextPageUrl);
          } else {
            // Emit a complete notification
            return EMPTY;
          }
        })
      );
    });
  }

  /**
   * Returns URL parameter for ResearchStudy query with all possible ResearchSubject
   * statuses used to filter ResearchStudies that does not have ResearchSubjects.
   */
  getHasResearchSubjectsParam(): string {
    const statuses = Object.keys(
      this.fhirBackend.getCurrentDefinitions().valueSetMapByPath[
        'ResearchSubject.status'
      ]
    ).join(',');
    return `&_has:ResearchSubject:study:status=${statuses}`;
  }
}
