# Sitemap route tools

## Introduiction
Sitemap route tools can query an xml sitemap (typically located at https://example.com/sitemap.xml) and check for the presence of selectors on the pages linked in the sitemap.

## Installation
Ensure node 24 is installed or you have nvm installed and use the .nvmrc file to set the correct node version.
```
nvm use
npx playwright install
npm i
```

Now run the server:
```
node server.js
```
You will see the url in terminal: `http://localhost:3333`

## Usage
- Enter the DDEV site URL in the "DDEV Site URL" field.
- Use the various fields in the UI to configure the checks you want to run.
- The fields are:
  - Label: A label for the check. (Useful for the exported report to identify the check)
  - Selector: A selector to check for on the page. Examples:
    - `#top-level-nav`
    - `.top-banner` (class selector)
    - `.top-banner, .top-nav` (comma-separated list of selectors)
    - `form` (element selector)
    - `input[type="email"]` (attribute selector)
    - `button[type="submit"]` (attribute selector)
  - Expected: Whether the selector should be present or absent. (present, absent, contains text...)
  - Exclude if inside: A selector to exclude from the check. (e.g. `#modal` or `.flyout` or `#drawer`)
- Click the "Scan" button to start the scan.
- The results will be displayed in the UI.
- The results can be exported as a JSON file.

## Debugging
You can enable debugging by checking the "Debug" checkbox. This will log the server logs and the browser console to the terminal.
