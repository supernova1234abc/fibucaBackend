FROM node:20

# Install Python 3
RUN apt-get update && apt-get install -y python3

WORKDIR /app
COPY . .

RUN npm install

CMD ["npm", "start"]