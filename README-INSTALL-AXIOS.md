# Install axios (backend)

1. Open a terminal and change into the backend folder:
   - cd c:\Users\coder\my-app\fibuca-backend

2. Install axios (pick one command):
   - npm:
     npm install axios --save
   - yarn:
     yarn add axios
   - pnpm:
     pnpm add axios

3. Restart your backend:
   - If you run with node:
     node index.js
   - If you use nodemon:
     npx nodemon index.js

4. Quick verify (in same backend folder):
   - node -e "require('axios'); console.log('axios ok')"
   - or start the server and call an endpoint that uses axios; check server logs for no require errors.

Notes:
- If your project has a root package.json and a workspace setup, run the install command in the package that contains backend/index.js.
- After installation, the existing `const axios = require('axios')` line in index.js will work.
