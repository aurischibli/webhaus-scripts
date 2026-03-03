window.addEventListener('DOMContentLoaded', function () {
  var STORAGE_KEY = 'gate-passed-date';
  var DAYS = 30;

  function hasValidEntry() {
    var stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return false;
    var diff = (Date.now() - parseInt(stored)) / (1000 * 60 * 60 * 24);
    return diff < DAYS;
  }

  var overlay = document.getElementById('gate-overlay');
  var popup = document.getElementById('gate-popup');

  if (hasValidEntry()) {
    return;
  }

  if (overlay) {
    overlay.style.display = 'flex';
    overlay.style.opacity = '0';
    requestAnimationFrame(function () {
      overlay.style.transition = 'opacity 0.4s ease';
      overlay.style.opacity = '1';
    });
  }

  if (popup) {
    setTimeout(function () {
      popup.style.opacity = '1';
      popup.style.transform = 'translateY(0px)';
    }, 400);
  }

  function unlockPage() {
    if (overlay) {
      overlay.style.transition = 'opacity 0.4s ease';
      overlay.style.opacity = '0';
      setTimeout(function () { overlay.style.display = 'none'; }, 400);
    }
  }

  var ABN_GUID = '4c055c04-2a8f-4de0-8ea1-3faf5c219f9d';

  function formatABN(abn) {
    return abn.replace(/\s+/g, '').replace(/[^0-9]/g, '');
  }

  function isValidABNFormat(abn) {
    if (abn.length !== 11) return false;
    var weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
    var digits = abn.split('').map(Number);
    digits[0] -= 1;
    var sum = digits.reduce(function(acc, d, i) { return acc + d * weights[i]; }, 0);
    return sum % 89 === 0;
  }

  function lookupABNJsonp(abn) {
    return new Promise(function(resolve, reject) {
      var callbackName = 'abnCallback_' + Date.now();
      var script = document.createElement('script');

      var timeout = setTimeout(function() {
        delete window[callbackName];
        script.remove();
        reject(new Error('Request timed out'));
      }, 8000);

      window[callbackName] = function(data) {
        clearTimeout(timeout);
        delete window[callbackName];
        script.remove();
        resolve(data);
      };

      script.src = 'https://abr.business.gov.au/json/AbnDetails.aspx?abn=' + abn + '&guid=' + ABN_GUID + '&callback=' + callbackName;
      script.onerror = function() {
        clearTimeout(timeout);
        delete window[callbackName];
        reject(new Error('Script load failed'));
      };

      document.head.appendChild(script);
    });
  }

  function createErrorEl(parent) {
    var el = document.createElement('div');
    el.style.cssText = 'font-size: 13px; margin-top: 4px; height: 18px; visibility: hidden; transition: color 0.2s ease; overflow: hidden;';
    el.textContent = '\u00A0';
    parent.appendChild(el);
    return el;
  }

  function setError(errorEl, field, message) {
    errorEl.style.color = 'red';
    errorEl.style.visibility = 'visible';
    errorEl.textContent = message;
    if (field) field.style.borderColor = 'red';
  }

  function setSuccess(errorEl, field, message) {
    errorEl.style.color = 'green';
    errorEl.style.visibility = 'visible';
    errorEl.textContent = message;
    if (field) field.style.borderColor = 'green';
  }

  function clearStatus(errorEl, field) {
    errorEl.style.visibility = 'hidden';
    errorEl.textContent = '\u00A0';
    if (field) field.style.borderColor = '';
  }

  var abnField      = document.querySelector('input[data-field="abn"]');
  var stockField    = document.querySelector('select[data-field="stock"]');
  var brandsWrapper = document.querySelector('[data-field-brands]');
  var form          = document.querySelector('#gate-overlay form');
  var abnVerified   = false;

  var abnError    = abnField      ? createErrorEl(abnField.parentElement)   : null;
  var stockError  = stockField    ? createErrorEl(stockField.parentElement) : null;
  var brandsError = brandsWrapper ? createErrorEl(brandsWrapper)            : null;

  if (abnField) {
    abnField.addEventListener('input', function() {
      abnVerified = false;
      clearStatus(abnError, abnField);
    });

    abnField.addEventListener('blur', function() {
      var abn = formatABN(abnField.value);
      clearStatus(abnError, abnField);

      if (abn.length === 0) return;

      if (!isValidABNFormat(abn)) {
        setError(abnError, abnField, 'Invalid ABN. Please enter a valid 11-digit ABN.');
        return;
      }

      abnField.disabled = true;
      lookupABNJsonp(abn).then(function(data) {
        if (data.EntityName) {
          abnVerified = true;
          setSuccess(abnError, abnField, '✓ Valid ABN – ' + data.EntityName);
        } else {
          abnVerified = false;
          setError(abnError, abnField, data.Message || 'ABN not found or not currently active.');
        }
      }).catch(function() {
        setError(abnError, abnField, 'Could not verify ABN. Please try again.');
      }).finally(function() {
        abnField.disabled = false;
      });
    });
  }

  if (stockField) {
    stockField.addEventListener('change', function() {
      clearStatus(stockError, stockField);
      if (stockField.value === 'Yes') {
        setError(stockError, stockField, 'Sorry, this page is only available to salons that do not currently stock Schwarzkopf Professional IGORA.');
      }
    });
  }

  function atLeastOneChecked(wrapper) {
    var checkboxes = wrapper.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < checkboxes.length; i++) {
      if (checkboxes[i].checked) return true;
    }
    return false;
  }

  if (brandsWrapper) {
    brandsWrapper.addEventListener('change', function() {
      if (atLeastOneChecked(brandsWrapper)) {
        clearStatus(brandsError, null);
        brandsWrapper.style.outline = '';
      }
    });
  }

  if (form) {
    form.addEventListener('submit', function(e) {
      var blocked = false;

      if (abnField && !abnVerified) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setError(abnError, abnField, 'Please verify your ABN before submitting.');
        blocked = true;
      }

      if (stockField && stockField.value === 'select') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setError(stockError, stockField, 'Please indicate whether you currently stock Schwarzkopf Professional IGORA.');
        blocked = true;
      }

      if (stockField && stockField.value === 'Yes') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setError(stockError, stockField, 'Please get in touch with your Schwarzkopf Professional representative.');
        blocked = true;
      }

      if (brandsWrapper && !atLeastOneChecked(brandsWrapper)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setError(brandsError, null, 'Please select at least one range.');
        brandsWrapper.style.outline = '1px solid red';
        blocked = true;
      }

      if (!blocked) {
        localStorage.setItem(STORAGE_KEY, Date.now().toString());
        unlockPage();
      }
    });
  }
});
