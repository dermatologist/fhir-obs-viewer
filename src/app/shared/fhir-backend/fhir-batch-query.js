import definitionsIndex from '../definitions/index.json';

// An object used to cache responses to HTTP requests
import queryResponseCache from './query-response-cache';

// The value of property status in the rejection object when request is aborted due to clearPendingRequests execution
export const HTTP_ABORT = 0;
// The value of property status in the rejection object when the FHIR version is not supported by RDF
export const UNSUPPORTED_VERSION = -1;

// Rate limiting interval - the time interval in milliseconds for which a limited number of requests can be specified
const RATE_LIMIT_INTERVAL = 1000;

// A map from version name to possible research study statuses.
// They are hardcoded because we don't have access to the specification
// definitions in this file.
const researchStudyStatusesByVersion = {
  R4: [
    'candidate',
    'eligible',
    'follow-up',
    'ineligible',
    'not-registered',
    'off-study',
    'on-study',
    'on-study-intervention',
    'on-study-observation',
    'pending-on-study',
    'potential-candidate',
    'screening',
    'withdrawn'
  ].join(','),
  R5: ['draft', 'active', 'retired', 'unknown'].join(',')
};

// Javascript client for FHIR with the ability to automatically combine requests in a batch
export class FhirBatchQuery {
  /**
   * Requests are executed or combined depending on the parameters passed to this method.
   * @constructor
   * @param {string} serviceBaseUrl - FHIR REST API Service Base URL (https://www.hl7.org/fhir/http.html#root)
   * @param {number} maxRequestsPerBatch - the maximum number of requests that can be combined (1 - turn off combined requests)
   * @param {number} maxActiveRequests - the maximum number of requests that can be executed simultaneously
   * @param {number} batchTimeout - the time in milliseconds between requests that can be combined
   */
  constructor({
    serviceBaseUrl = '',
    maxRequestsPerBatch,
    maxActiveRequests,
    batchTimeout
  }) {
    this._serviceBaseUrl = serviceBaseUrl;
    this._authorizationHeader = null;
    this._pending = [];
    this._batchTimeoutId = null;
    this._batchTimeout =
      batchTimeout || sessionStorage.getItem('batchTimeout') || 20;
    this._maxPerBatch =
      maxRequestsPerBatch || sessionStorage.getItem('maxPerBatch') || 10;
    this._maxActiveReq =
      maxActiveRequests || sessionStorage.getItem('maxActiveReq') || 6;
    this._activeReq = [];
    this._onChangeListeners = [];
    // Timeout between requests in milliseconds
    // (=0, if there is no timeout between requests):
    this._msBetweenRequests = 0;
    // The time at which the last successful request was completed
    this._lastSuccessTime = Date.now();
    // The client side should give up if no successful response in 90 seconds
    this._giveUpTimeout = 90 * 1000;
    // NCBI E-utilities API Key
    this._apiKey = sessionStorage.getItem('apiKey') || '';
    // The string describes an initialization context which is used to
    // distinguish between pre-login and post-login initialization requests
    this.initContext = '';
  }

  /**
   * Returns current FHIR REST API Service Base URL
   * (See https://www.hl7.org/fhir/http.html#root)
   * @return {string}
   */
  getServiceBaseUrl() {
    return this._serviceBaseUrl;
  }

  /**
   * Sets the authorization header value.
   */
  setAuthorizationHeader(value) {
    this._authorizationHeader = value;
  }

  /**
   * @typedef FHIRServerFeatures
   * @type {Object}
   * @property {boolean} [sortObservationsByDate] - whether sorting
   *           Observations by date available
   * @property {boolean} [sortObservationsByAgeAtEvent] - whether sorting
   *           Observations by age-at-event available
   */

  /**
   * Returns an object describing the server features.
   * @return {FHIRServerFeatures}
   */
  getFeatures() {
    return this._features || {};
  }

  /**
   * Return version name e.g. "R4"
   * @return {string}
   */
  getVersionName() {
    return this._versionName;
  }

  /**
   * Returns the name of the persistent cache for initial queries of public
   * data and server capability checks.
   * @param useInitContext whether to use this.initContext in cache name. Defaults to true.
   * @returns {string}
   */
  getInitCacheName(useInitContext = true) {
    return (
      'init-' +
      (useInitContext && this.initContext ? this.initContext + '-' : '') +
      this._serviceBaseUrl
    );
  }

  /**
   * Returns common options for initialization requests
   * @param useInitContext whether to use this.initContext in cache name. Defaults to true.
   * @returns {Object}
   */
  getCommonInitRequestOptions(useInitContext = true) {
    return {
      combine: false,
      retryCount: 2,
      cacheName: this.getInitCacheName(useInitContext),
      // Initialization requests are cached for a day:
      expirationTime: 24 * 60 * 60,
      cacheErrors: true
    };
  }

  /**
   * Initialize/reinitialize FhirBatchQuery instance.
   * @param {string} [newServiceBaseUrl] - new FHIR REST API Service Base URL
   *                 (https://www.hl7.org/fhir/http.html#root)
   * @param {string} [context] - string describes an initialization context
   *  which is used to distinguish between pre-login and post-login
   *  initialization requests.
   * @return {Promise}
   */
  initialize(newServiceBaseUrl, context = '') {
    const serverUrlChanged =
      newServiceBaseUrl && newServiceBaseUrl !== this._serviceBaseUrl;

    if (serverUrlChanged) {
      this._serviceBaseUrl = newServiceBaseUrl;
    }

    const contextChanged =
      arguments.length >= 2 && this.initContext !== context;

    if (serverUrlChanged || contextChanged) {
      this.clearPendingRequests();
      delete this._initializationPromise;
      this._msBetweenRequests = 0;
      this.initContext = context;
    }

    // const currentServiceBaseUrl = this._serviceBaseUrl;

    if (this._initializationPromise) {
      return this._initializationPromise;
    }
    this._features = {};
    // if (this._isDbgap) {
    //   this._initializationPromise = Promise.allSettled([
    //     // Query to extract the consent group that must be included as _security param in particular queries.
    //     this.getWithCache('ResearchSubject', this.getCommonInitRequestOptions())
    //   ]).then(([researchSubject]) => {
    //     if (currentServiceBaseUrl !== this._serviceBaseUrl) {
    //       return Promise.reject({
    //         status: HTTP_ABORT,
    //         error: 'Outdated response to initialization request.'
    //       });
    //     }
    //     if (
    //       researchSubject &&
    //       researchSubject.status === 'rejected' &&
    //       /Deny access to all but these consent groups: (.*) -- codes from last denial/.test(
    //         researchSubject.reason.error
    //       )
    //     ) {
    //       this._features.consentGroup = RegExp.$1.replace(', ', ',');
    //       return this.makeInitializationCalls(true);
    //     } else {
    //       return this.makeInitializationCalls();
    //     }
    //   });
    // } else {
    this._initializationPromise = this.makeInitializationCalls();
    // }
    return this._initializationPromise;
  }

  /**
   * Makes multiple queries to server and determine values in _feature property.
   * @param withSecurityTag whether to add _security search parameter in applicable queries
   * @returns {Promise<void>}
   */
  makeInitializationCalls(withSecurityTag = false) {
    const currentServiceBaseUrl = this._serviceBaseUrl;
    const securityParam = withSecurityTag
      ? `&_security=${this._features.consentGroup}`
      : '';
    // Common options for initialization requests
    // retryCount=2, We should not try to resend the first request to the server many times - this could be the wrong URL
    const options = this.getCommonInitRequestOptions();
    // useInitContext=false, The request is cached as the same name before and after login, so we don't make the request again after login.
    const options_noInitContext = this.getCommonInitRequestOptions(false);

    // Below are initialization requests that are always made.
    const initializationRequests = Promise.allSettled([
      // Retrieve the information about a server's capabilities (https://www.hl7.org/fhir/http.html#capabilities)
      this.getWithCache(
        'metadata?_elements=fhirVersion',
        options_noInitContext
      ),
      // Check if server has Research Study data
      this.getWithCache('ResearchStudy?_elements=id&_count=1', options),
      // Check if batch request is supported
      this._request({
        method: 'POST',
        url: this._serviceBaseUrl,
        body: JSON.stringify({
          resourceType: 'Bundle',
          type: 'batch'
        }),
        logPrefix: 'Batch',
        combine: false,
        retryCount: 2
      })
    ])
      .then(([metadata, hasResearchStudy, batch]) => {
        if (currentServiceBaseUrl !== this._serviceBaseUrl) {
          return Promise.reject({
            status: HTTP_ABORT,
            error: 'Outdated response to initialization request.'
          });
        }
        if (metadata.status === 'fulfilled') {
          const fhirVersion = metadata.value.data.fhirVersion;
          this._versionName = getVersionNameByNumber(fhirVersion);
          if (!this._versionName) {
            return Promise.reject({
              status: UNSUPPORTED_VERSION,
              error: 'Unsupported FHIR version: ' + fhirVersion
            });
          }
          this._features.hasResearchStudy =
            hasResearchStudy.status === 'fulfilled' &&
            hasResearchStudy.value.data.entry &&
            hasResearchStudy.value.data.entry.length > 0;
          this._features.batch = batch.status === 'fulfilled';
        } else {
          // If initialization fails, do not cache initialization responses
          this.clearCacheByName(this.getInitCacheName());
          // Abort other initialization requests
          this.clearPendingRequests();
          return Promise.reject({
            error:
              "Could not retrieve the FHIR server's metadata. Please make sure you are entering the base URL for a FHIR server."
          });
        }
      })
      .then(() => {
        // Check if server has at least one Research Study with Research Subjects.
        // No need to make this request if there is no Research Study at all.
        return this._features.hasResearchStudy
          ? this.getWithCache(
              `ResearchStudy?_elements=id&_count=1&&_has:ResearchSubject:study:status=${
                researchStudyStatusesByVersion[this._versionName]
              }`,
              options
            ).then(
              ({ data }) => {
                this._features.hasAvailableStudy = data.entry?.length > 0;
              },
              () => {
                this._features.hasAvailableStudy = false;
              }
            )
          : Promise.resolve();
      });
    // On dbGaP server, only do initializationRequests2 requests after login.
    if (this.initContext === 'dbgap-pre-login') {
      return initializationRequests;
    }
    // Below are initialization requests that are not made if it's dbGaP server and user hasn't logged in.
    const initializationRequests2 = Promise.allSettled([
      // Check if sorting Observations by date is supported
      this.getWithCache(
        `Observation?date=gt1000-01-01&_elements=id&_count=1${securityParam}`,
        options
      ),
      // Check if sorting Observations by age-at-event is supported
      this.getWithCache(
        `Observation?_sort=age-at-event&_elements=id&_count=1${securityParam}`,
        options
      ),
      // Check if operation $lastn on Observation is supported
      this.getWithCache(
        `Observation/$lastn?max=1&_elements=code,value,component&code:text=zzzzz&_count=1${securityParam}`,
        options
      ),
      // Check if interpretation search parameter is supported
      this.getWithCache(
        `Observation?interpretation:not=zzz&_elements=id&_count=1${securityParam}`,
        options
      ),
      this.checkNotModifierIssue()
    ]).then(
      ([
        observationsSortedByDate,
        observationsSortedByAgeAtEvent,
        lastnLookup,
        interpretation,
        hasNotModifierIssue
      ]) => {
        Object.assign(this._features, {
          sortObservationsByDate:
            observationsSortedByDate.status === 'fulfilled' &&
            observationsSortedByDate.value.data.entry &&
            observationsSortedByDate.value.data.entry.length > 0,
          sortObservationsByAgeAtEvent:
            observationsSortedByAgeAtEvent.status === 'fulfilled' &&
            observationsSortedByAgeAtEvent.value.data.entry &&
            observationsSortedByAgeAtEvent.value.data.entry.length > 0,
          lastnLookup: lastnLookup.status === 'fulfilled',
          interpretation:
            interpretation.status === 'fulfilled' &&
            interpretation.value.data.entry &&
            interpretation.value.data.entry.length > 0,
          hasNotModifierIssue:
            hasNotModifierIssue.status === 'fulfilled' &&
            hasNotModifierIssue.value
        });
      }
    );
    return Promise.all([initializationRequests, initializationRequests2]);
  }

  /**
   * Checks if the ":not" search parameter modifier is interpreted incorrectly
   * (HAPI FHIR server issue).
   * @return {Promise<boolean>}
   */
  checkNotModifierIssue() {
    return this.getWithCache(
      'Observation?_count=1',
      this.getCommonInitRequestOptions()
    ).then((response) => {
      const obs = response.data.entry?.[0].resource;
      const firstCode =
        obs?.code.coding?.[0].system + '%7C' + obs?.code.coding?.[0].code;
      const patientRef = obs?.subject?.reference;
      return firstCode && patientRef
        ? this.getWithCache(
            `Observation?code:not=${firstCode}&subject=${patientRef}&_total=accurate&_count=1`,
            this.getCommonInitRequestOptions()
          ).then((oneCodeResp) => {
            const secondCode =
              oneCodeResp.data.entry?.[0].resource.code.coding?.[0].system +
              '%7C' +
              oneCodeResp.data.entry?.[0].resource.code.coding?.[0].code;
            return secondCode
              ? Promise.allSettled([
                  typeof oneCodeResp.data.total === 'number'
                    ? Promise.resolve(oneCodeResp)
                    : this.getWithCache(
                        `Observation?code:not=${firstCode}&subject=${patientRef}&_total=accurate&_summary=count`,
                        this.getCommonInitRequestOptions()
                      ),
                  this.getWithCache(
                    `Observation?code:not=${firstCode},${secondCode}&subject=${patientRef}&_total=accurate&_summary=count`,
                    this.getCommonInitRequestOptions()
                  )
                ]).then(([summaryOneCodeResp, summaryTwoCodeResp]) => {
                  return summaryOneCodeResp.status === 'fulfilled' &&
                    summaryTwoCodeResp.status === 'fulfilled'
                    ? Promise.resolve(
                        summaryTwoCodeResp.value.data.total <
                          summaryOneCodeResp.value.data.total
                      )
                    : Promise.reject();
                })
              : Promise.reject();
          })
        : Promise.reject();
    });
  }

  /**
   * Adds a listener for the parameters change event
   * and returns a function to remove this listener
   * @param {Function} handler - callback function which is used to signal
   *   that parameters changed by FhirBatchQuery
   * @return {Function}
   */
  addChangeEventListener(handler) {
    this._onChangeListeners.push(handler);

    return () => {
      const index = this._onChangeListeners.indexOf(handler);
      if (index > -1) {
        this._onChangeListeners.splice(index, 1);
      }
    };
  }

  /**
   * Executes all parameter change event listeners
   */
  emitChangeEvent() {
    this._onChangeListeners.forEach((fn) => fn());
  }

  /**
   * Sets the maximum number of requests that can be combined
   * (1 - turn off combined requests)
   * @param {number} val
   */
  setMaxRequestsPerBatch(val) {
    this._maxPerBatch = val;
    sessionStorage.setItem('maxPerBatch', val);
  }

  /**
   * Gets the maximum number of requests that can be combined
   * @return {number}
   */
  getMaxRequestsPerBatch() {
    return this._maxPerBatch;
  }

  /**
   * Sets the maximum number of requests that can be executed simultaneously
   * @param {number} val
   */
  setMaxActiveRequests(val) {
    this._maxActiveReq = val;
    sessionStorage.setItem('maxActiveReq', val);
  }

  /**
   * Gets the maximum number of requests that can be executed simultaneously
   * @return {number}
   */
  getMaxActiveRequests() {
    return this._maxActiveReq;
  }

  /**
   * Sets the NCBI E-utilities API Key.
   * See https://ncbiinsights.ncbi.nlm.nih.gov/2017/11/02/new-api-keys-for-the-e-utilities/
   * @param {string} val
   */
  setApiKey(val) {
    this._apiKey = (val || '').trim();
    sessionStorage.setItem('apiKey', this._apiKey);
  }

  /**
   * Gets the NCBI E-utilities API Key.
   * @return {string}
   */
  getApiKey() {
    return this._apiKey;
  }

  /**
   * Adds a parameter to the source URL, or updates an existing one and returns
   * the new URL.
   * @param {string} url source URL
   * @param {string} name - parameter name
   * @param {string} value - parameter value
   * @return {string}
   */
  addParamToUrl(url, name, value) {
    const urlParts = url
      .split(/[?&]/)
      .filter((paramStr) => !paramStr.startsWith(name + '='));
    return (
      urlParts[0] +
      '?' +
      urlParts
        .slice(1)
        .concat([name + '=' + encodeURIComponent(value)])
        .join('&')
    );
  }

  static clearCache() {
    queryResponseCache.clearAll();
  }

  /**
   * Gets the response content from a URL.
   * @param {string} url - the URL whose data is to be retrieved.
   * @param {boolean} combine - whether to combine requests in a batch
   * @param {AbortSignal} [signal] - a signal object that allows aborting of
   *   the HTTP request via an AbortController object.
   *   See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal
   * @param {number|boolean} retryCount - maximum number of retries or false
   *                   to use _giveUpTimeout
   * @return {Promise} resolves/rejects with Object {status, data}, where
   *                   status is HTTP status number,
   *                   data is Object constructed from a JSON response
   */
  get(url, { combine = true, retryCount = false, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      let fullUrl = this.getFullUrl(url);
      let body, contentType, method;
      // Maximum URL length is 2048, but we can add some parameters later
      // (in the "_request" function).
      // '.../$lastn/_search' is not a valid operation. We can wrap it in
      // a batch request instead (see "_postPending" function).
      if (fullUrl.length > 1900 && fullUrl.indexOf('/$lastn') === -1) {
        contentType = 'application/x-www-form-urlencoded';
        method = 'POST';
        [fullUrl, body] = fullUrl.split('?');
        fullUrl += '/_search';
      }
      this._pending.push({
        url: fullUrl,
        body,
        contentType,
        method,
        combine,
        signal,
        retryCount,
        resolve,
        reject
      });
      if (this._pending.length < this._maxPerBatch) {
        clearTimeout(this._batchTimeoutId);
        this._batchTimeoutId = setTimeout(
          () => this._postPending(),
          this._batchTimeout
        );
      } else {
        this._postPending();
      }
    });
  }

  /**
   * Returns timeout from the Retry-After response HTTP header.
   * See https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After for details
   * @param {XMLHttpRequest} xhr
   * @return {number} - timeout in milliseconds
   */
  static getRetryAfterTimeout(xhr) {
    const retryAfterHeader = xhr.getResponseHeader('Retry-After');
    // Use default timeout if there is no Retry-After header. This can happen
    // when the request was aborted because the preflight request returned HTTP-429.
    let timeout = RATE_LIMIT_INTERVAL;
    if (retryAfterHeader) {
      if (/^\d+$/.test(retryAfterHeader)) {
        timeout = parseInt(retryAfterHeader) * 1000;
      } else {
        timeout = new Date(retryAfterHeader) - Date.now();
        if (isNaN(timeout) || timeout < 0) {
          // Use default timeout if date is not valid
          timeout = RATE_LIMIT_INTERVAL;
        }
      }
    }

    return timeout;
  }

  /**
   * Guesses timeout between rate-limited API requests.
   * This currently works only for APIs that either do not have a rate limit,
   * or which have one and indicate it with the "x-ratelimit-limit" header.
   * We assume this value in the "x-ratelimit-limit" header sets the number
   * of requests per 1 second.
   * @param {XMLHttpRequest} xhr
   * @return {number} - timeout in milliseconds,
   *         0 - if there is no timeout between requests.
   */
  guessMsBetweenRequests(xhr) {
    // Workaround to avoid Chrome errors: Refused to get unsafe header "x-ratelimit-limit"
    // See https://trackjs.com/blog/refused-unsafe-header/ for details
    const xRateLimitHeader = /x-ratelimit-limit/i.test(
      xhr.getAllResponseHeaders()
    )
      ? xhr.getResponseHeader('x-ratelimit-limit')
      : '';
    if (/^\d+$/.test(xRateLimitHeader)) {
      // For each request, the browser sends an additional preflight request;
      // therefore, we need to send half the number of requests.
      // Examples:
      // if we have "x-ratelimit-limit: 3", we should send 1 request per second to avoid HTTP-429.
      // if we have "x-ratelimit-limit: 2", we should send 1 request per second to avoid HTTP-429.
      // if we have "x-ratelimit-limit: 1", this will not work at all - we can't skip preflight request.
      const limit = Math.max(1, Math.floor(parseInt(xRateLimitHeader) / 2));

      // TODO: Adjust the maximum number of requests that can be combined in a batch
      // after adding the ability to view this new value by the user in the "Advanced settings"
      // section? In this case, the percentage of data loading progress will practically
      // not be displayed:
      // this._maxPerBatch = Math.max(Math.ceil(this._pending.length / limit), 10)

      // Use value slightly longer than the rate limit interval to avoid HTTP-429 responses
      this._msBetweenRequests = Math.ceil((RATE_LIMIT_INTERVAL + 60) / limit);
    }
  }

  /**
   * Sends XMLHttpRequest
   * @private
   * @param {Object} settings - a set of key/value pairs that configure
   *                 the XMLHttpRequest request
   * @param {string} settings.method - HTTP method
   * @param {string} settings.url - request URL
   * @param {string} settings.body - request body if method === 'POST'
   * @param {boolean} settings.combine - whether to combine requests in a batch
   * @param {AbortSignal} [settings.signal] - a signal object that allows aborting of
   *   the HTTP request via an AbortController object.
   *   See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal
   * @param {number|boolean} settings.retryCount - maximum number of retries or false to use _giveUpTimeout
   * @param {string} settings.contentType - Content-Type request header value
   * @param {string} settings.logPrefix - prefix for console log messages
   * @return {Promise}
   */
  _request({
    method = 'GET',
    url,
    body = undefined,
    combine = true,
    signal = null,
    retryCount = false,
    contentType = 'application/fhir+json',
    logPrefix = ''
  }) {
    // Update last request time on request
    this._lastRequestTime = Date.now();
    return new Promise((resolve, reject) => {
      const oReq = new XMLHttpRequest(),
        startAjaxTime = new Date();

      function abortRequest() {
        oReq.abort();
      }
      signal?.addEventListener('abort', abortRequest);

      oReq.onreadystatechange = () => {
        if (oReq.readyState === 4) {
          signal?.removeEventListener('abort', abortRequest);
          this.guessMsBetweenRequests(oReq);
          const currentRequestIndex = this._activeReq.indexOf(oReq);
          if (currentRequestIndex !== -1) {
            this._activeReq.splice(currentRequestIndex, 1);
          } else {
            // if aborted due to clearPendingRequests
            reject({ status: HTTP_ABORT, error: 'Abort' });
          }
          const responseTime = new Date() - startAjaxTime;
          // Maximum time for preflight request.
          const maxTimeForPreflightRequest = 15000;
          console.log(
            `${
              logPrefix ? logPrefix + ' ' : ''
            }AJAX call returned in ${responseTime}`
          );
          const status = oReq.status;

          if (this.isOK(status)) {
            this._lastSuccessTime = Date.now();
            resolve({ status, data: JSON.parse(oReq.responseText) });
          } else if (
            // When the preflight request returns HTTP-429, the real request is
            // aborted. If the request is aborted after 15 seconds, we can expect
            // that this is not because the preflight request returned HTTP-429,
            // but because the server timed out. In this case, we will not try
            // to resubmit this request.
            (status === 429 ||
              (status === HTTP_ABORT &&
                !signal?.aborted &&
                responseTime < maxTimeForPreflightRequest)) &&
            (typeof retryCount !== 'number' || --retryCount > 0) &&
            Date.now() - this._lastSuccessTime < this._giveUpTimeout
          ) {
            if (this._msBetweenRequests < RATE_LIMIT_INTERVAL) {
              this._msBetweenRequests += 100;
              this._maxActiveReq = 1;
              this.emitChangeEvent();
            }
            this._pending.unshift({
              method,
              url,
              body,
              combine,
              signal,
              retryCount,
              contentType,
              logPrefix,
              resolve,
              reject
            });
            setTimeout(
              () => this._postPending(),
              FhirBatchQuery.getRetryAfterTimeout(oReq)
            );
            return;
          } else if (status === HTTP_ABORT) {
            reject({
              status: HTTP_ABORT,
              error: 'Abort'
            });
          } else {
            let error;
            try {
              error = oReq.responseText ? JSON.parse(oReq.responseText) : {};
            } catch (e) {
              error = {};
            }
            reject({ status, error: this._getErrorDiagnostic(error) });
          }
          this._postPending();
        }
      };

      let sendUrl = url;
      if (this._apiKey && sendUrl.indexOf('api_key=') === -1) {
        sendUrl = this.addParamToUrl(sendUrl, 'api_key', this._apiKey);
      }

      if (sendUrl.indexOf('_format=json') === -1) {
        sendUrl = this.addParamToUrl(sendUrl, '_format', 'json');
      }

      oReq.open(method, sendUrl);
      oReq.timeout = this._giveUpTimeout;

      if (method !== 'GET') {
        oReq.setRequestHeader('Content-Type', contentType);
      }

      if (this._authorizationHeader) {
        oReq.setRequestHeader('Authorization', this._authorizationHeader);
      }

      oReq.send(body);
      this._activeReq.push(oReq);
    });
  }

  /**
   * Returns an array of objects describing requests that can be performed with
   * a single API request.
   * @return {Array}
   */
  getNextRequestsToPerform() {
    let requests = [];

    while (this._pending.length && this._maxPerBatch > requests.length) {
      const req = this._pending.shift();
      if (req.signal?.aborted) {
        // If the request was aborted before sending, just reject
        // the corresponding promise:
        req.reject({ status: HTTP_ABORT, error: 'Abort' });
      } else {
        if (req.method === 'POST' || req.combine === false) {
          if (requests.length === 0) {
            requests.push(req);
          } else {
            this._pending.unshift(req);
          }
          break;
        } else {
          requests.push(req);
        }
      }
    }
    return requests;
  }

  /**
   * Sends pending requests as batch or single
   * @private
   */
  _postPending() {
    if (this._activeReq.length >= this._maxActiveReq) {
      return;
    }

    // Apply timeout between requests
    const pause = this._lastRequestTime
      ? this._msBetweenRequests - Date.now() + this._lastRequestTime
      : 0;
    if (pause > 0) {
      clearTimeout(this._postPendingTimeout);
      this._postPendingTimeout = setTimeout(() => {
        this._postPending();
      }, pause);
      return;
    }

    const requests = this.getNextRequestsToPerform();

    if (
      requests.length > 1 ||
      // If we have only one request, but its URL is too long, we can wrap it in
      // a batch query.
      // Maximum URL length is 2048, but we can add some parameters later
      // (in the "_request" function).
      (requests.length === 1 && requests[0].url.length > 1900)
    ) {
      // A controller object that allows aborting of the batch request if all
      // requests are aborted
      const abortController = new AbortController();
      const signal = abortController.signal;
      // Uncancelled request counter
      let activeReqCount = requests.length;

      const body = JSON.stringify({
        resourceType: 'Bundle',
        type: 'batch',
        entry: requests.map(({ url, signal }) => {
          // Track the number of uncanceled requests and abort the batch request
          // if all requests are aborted
          signal.addEventListener('abort', () => {
            if (--activeReqCount === 0) {
              abortController.abort();
            }
          });

          return {
            request: {
              method: 'GET',
              url: this.getRelativeUrl(url)
            }
          };
        })
      });

      this._request({
        method: 'POST',
        url: this._serviceBaseUrl,
        body,
        signal,
        logPrefix: 'Batch'
      }).then(
        ({ data }) => {
          requests.forEach(({ resolve, reject, signal }, index) => {
            // See Batch/Transaction response description here:
            // https://www.hl7.org/fhir/http.html#transaction-response
            const entry = data.entry[index];
            const status = parseInt(entry.response.status);
            // TODO: Not sure if we need to abort the request if we already have
            //   the response. The response will not be cached in this case.
            //   But perhaps it is better not to cache responses that we don't need.
            if (signal?.aborted) {
              reject({ status: HTTP_ABORT, error: 'Abort' });
            } else if (this.isOK(status)) {
              resolve({ status, data: entry.resource || {} });
            } else {
              reject({
                status,
                error: this._getErrorDiagnostic(entry.response.outcome)
              });
            }
          });
        },
        ({ status, error }) => {
          // If the batch request fails, show an error only for the first
          // non-aborted request in the batch, following requests are marked
          // as aborted:
          let batchErrorReturned = false;
          for (let i = 0; i < requests.length; ++i) {
            if (batchErrorReturned || requests[i].signal?.aborted) {
              requests[i].reject({ status: HTTP_ABORT, error: 'Abort' });
            } else {
              batchErrorReturned = true;
              requests[i].reject({ status, error });
            }
          }
        }
      );
    } else if (requests.length) {
      const { resolve, reject, ...options } = requests[0];
      this._request(options).then(resolve, reject);
    }
  }

  /**
   * Returns text with FHIR response issue diagnostics
   * @param {Object} data
   * @return {string}
   */
  _getErrorDiagnostic(data) {
    if (data && data.issue && data.issue.length) {
      return data.issue.map((item) => item.diagnostics).join('\n') || '';
    }

    return 'Unknown Error';
  }

  clearPendingRequests() {
    this._pending.length = 0;
    this._activeReq.forEach((request) => {
      request.abort();
    });
    this._activeReq = [];
  }

  getFullUrl(url) {
    return /^http[s]{0,1}:\/\//.test(url)
      ? url
      : `${this._serviceBaseUrl}/${url}`;
  }

  getRelativeUrl(url) {
    return url.indexOf(this._serviceBaseUrl) === 0
      ? url.substr(this._serviceBaseUrl.length + 1)
      : url;
  }

  /**
   * Checks the HTTP response status is OK
   * @param status
   * @return {boolean}
   */
  isOK(status) {
    return status >= 200 && status < 300;
  }

  /**
   * Like "get", but uses a cache if the URL has been requested before.
   * @param {string} url - the URL whose data is to be retrieved.
   * @param {Object} [options] - additional options:
   * @param {boolean} [options.combine] - whether to combine requests in a batch,
   *                  true by default.
   * @param {AbortSignal} [options.signal] - a signal object that allows aborting of
   *   the HTTP request via an AbortController object.
   *   See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal
   * @param {number|boolean} [options.retryCount] - maximum number of retries
   *                  or false to use _giveUpTimeout, false by default.
   * @param {null|string} [options.cacheName] - if specified, then sets the name
   *   for the cache in "window.caches", otherwise a javascript variable is
   *   used as a temporary cache.
   * @param {number} [options.expirationTime] - the number of seconds the new
   *   entry can be in the cache before expiring.
   * @param {boolean} [options.cacheErrors] - whether to cache error responses,
   *   false by default.
   * @return {Promise} resolves/rejects with Object {status, data}, where
   *   status is HTTP status number, data is Object constructed from a JSON
   *   response.
   */
  getWithCache(url, options = {}) {
    options = {
      combine: true,
      retryCount: false,
      cacheName: null,
      cacheErrors: false,
      ...options
    };

    return new Promise((resolve, reject) => {
      const fullUrl = this.getFullUrl(url);
      queryResponseCache.get(fullUrl, options).then((cachedResponse) => {
        if (cachedResponse) {
          console.log('Using cached data');
          if (cachedResponse.status >= 200 && cachedResponse.status < 300) {
            resolve(cachedResponse);
          } else {
            reject(cachedResponse);
          }
        } else {
          this.get(fullUrl, options).then(
            (response) => {
              queryResponseCache.add(fullUrl, response, options).then(() => {
                resolve(response);
              });
            },
            (errorResponse) => {
              (options.cacheErrors && errorResponse.status !== HTTP_ABORT
                ? queryResponseCache.add(fullUrl, errorResponse, options)
                : Promise.resolve()
              ).then(() => {
                reject(errorResponse);
              });
            }
          );
        }
      });
    });
  }

  /**
   * Whether cached response data exists for the URL and has not expired.
   * @param {string} url - URL
   * @param {string} [cacheName] - cache name for persistent data storage
   *   between sessions, if not specified, gets response data from the temporary
   *   cache that will disappear when the page is reloaded.
   * @returns {Promise<boolean>}
   */
  isCached(url, cacheName) {
    return queryResponseCache.hasNotExpiredData(url, cacheName);
  }

  /**
   * Clears persistent cache data by cache name.
   * @param {string} cacheName - cache name for persistent data storage between
   *   sessions.
   * @returns {Promise<boolean>}
   */
  clearCacheByName(cacheName) {
    return queryResponseCache.clearByCacheName(cacheName);
  }

  /**
   * Extracts next page URL from a response (see: https://www.hl7.org/fhir/http.html#paging)
   * @param {Object} response
   * @return {string|false}
   */
  getNextPageUrl(response) {
    let result;
    return (
      response.link.some(
        (link) => link.relation === 'next' && (result = link.url)
      ) && result
    );
  }

  /**
   * The map/filter function for resources.
   * @callback ResourceMapFilterCallback
   * @param {Object} resource
   * @return {Promise<boolean|Object>}
   */

  /**
   * Returns the promise of resources(or mapped values) that meet the condition specified
   * in a filter(map) function and the total amount of resources.
   * Also, returns function "cancel" to reject this promise and stop the loading process.
   * @param {string|Promise} url - URL to get resources
   * @param {number} count - the target number of resources
   * @param {ResourceMapFilterCallback} filterMapFunction - the resourcesMapFilter method
   *   calls the filterMapFunction one time for each resource to determine whether the element
   *   should be included in the resulting array (returns Promise<true>),
   *   skipped (returns Promise<false>) or replaced with new value(returns Promise<Object>)
   * @param {number} [pageSize] - page size for resources loading
   * @return {{promise: Promise<{entry:Array, total: number}>, cancel: Function}}
   */
  resourcesMapFilter(url, count, filterMapFunction, pageSize) {
    // The value (this._maxPerBatch*this._maxActiveReq*2) is the optimal page size to get resources for filtering/mapping:
    // this value should be so minimal as not to load a lot of unnecessary data, but sufficient to allow parallel
    // loading of data to speed up the process.
    // For example, if we want to load Patients whose Encounters meet certain criteria,
    // we will load Encounters in portions of the specified optimal page size, and for each Encounter,
    // load the Patient and add it to the result (if it is not already in it) until we get the target number of Patients.
    let canceled = false;
    const promise = this._resourcesMapFilter(
      this.getWithCache(
        updateUrlWithParam(
          url,
          '_count',
          pageSize || this._maxPerBatch * this._maxActiveReq * 2
        )
      ),
      count,
      (resource) => {
        if (canceled) {
          return Promise.reject({ status: HTTP_ABORT, error: 'Abort' });
        }

        return filterMapFunction(resource);
      }
    );
    return {
      promise,
      cancel: () => {
        canceled = true;
      }
    };
  }

  /**
   * A private method that is called from a public method resourcesMapFilter.
   * Returns the promise of resources(or mapped values) that meet the condition specified
   * in a filter(map) function and the total amount of resources.
   * @param {Promise} firstRequest - promise to return the first page of resources
   * @param {number} count - the target number of resources
   * @param {ResourceMapFilterCallback} filterMapFunction -  - the _resourcesMapFilter method
   *   calls the filterMapFunction one time for each resource to determine whether the element
   *   should be included in the resulting array (returns Promise<true>),
   *   skipped (returns Promise<false>) or replaced with new value(returns Promise<Object>).
   * @return {Promise<{entry:Array, total: number}>}
   * @private
   */
  _resourcesMapFilter(firstRequest, count, filterMapFunction) {
    return new Promise((resolve, reject) => {
      firstRequest.then(({ data }) => {
        const resources = (data.entry || []).map((entry) => entry.resource);
        const total = data.total;
        Promise.all(
          resources.map((resource) => filterMapFunction(resource))
        ).then((match) => {
          const entry = [].concat(
            ...resources
              .map((res, index) => (match[index] === true ? res : match[index]))
              .filter((res) => res !== false)
          );
          const newCount = count - entry.length;
          const nextPageUrl = this.getNextPageUrl(data);

          if (entry.length < count && nextPageUrl) {
            this._resourcesMapFilter(
              this.getWithCache(nextPageUrl),
              newCount,
              filterMapFunction
            ).then((nextPage) => {
              resolve({
                entry: entry.concat(nextPage.entry),
                total: typeof total === 'number' ? total : nextPage.total
              });
            }, reject);
          } else {
            if (entry.length > count) {
              // Remove extra entries
              entry.length = count;
            }
            resolve({ entry, total });
          }
        }, reject);
      }, reject);
    });
  }
}

/**
 * Returns version name by version number or null if version number is not supported.
 * @example
 * // calling a function as shown below will return this string: 'R4'
 * getVersionNameByNumber('4.0.1')
 * @param versionNumber
 * @return {string|null}
 */
export function getVersionNameByNumber(versionNumber) {
  let versionName = null;

  Object.keys(definitionsIndex.versionNameByVersionNumberRegex).some(
    (versionRegEx) => {
      if (new RegExp(versionRegEx).test(versionNumber)) {
        versionName =
          definitionsIndex.versionNameByVersionNumberRegex[versionRegEx];
        return true;
      }
    }
  );

  return versionName;
}

/**
 * Adds/replaces URL parameter. Returns updated URL.
 * @param {string} url
 * @param {string} name - parameter name
 * @param {string|number} value - parameter value
 * @return {string}
 */
export function updateUrlWithParam(url, name, value) {
  if (!/^([^?]*)(\?([^?]*)|)$/.test(url)) {
    // This is not correct if the URL has two "?" - do nothing:
    return url;
  }
  const urlWithoutParams = RegExp.$1;
  const params = (RegExp.$3 || '')
    .split('&')
    .filter((item) => item && item.split('=')[0] !== name)
    .concat(`${name}=${encodeURIComponent(value)}`)
    .join('&');

  return params ? urlWithoutParams + '?' + params : urlWithoutParams;
}
