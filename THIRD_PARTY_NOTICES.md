# Third-party notices

The Haismart account-device endpoint/response mapping in `src/haier-cloud.ts` and the UDP discovery format/parser in `src/discovery.ts` are adapted from [haismart-local](https://github.com/enapt/haismart-local), reference commit `8443eb451d48ef0288bd3a671070b3f8ebc46698`:

- `packages/haismart-extractor/src/haismart_extractor/cloud.py`
- `packages/haismart-hrdp/src/haismart_hrdp/udiscovery.py`

The following upstream license applies to those portions:

```text
MIT License

Copyright (c) 2026 haismart-local contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Runtime packages retain their own license files in `node_modules` when installed or included in the container. Haier and Haismart are trademarks of their respective owners. This project is independent and is not endorsed by Haier.
