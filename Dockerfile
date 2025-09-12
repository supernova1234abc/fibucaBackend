FROM node:20

# Install Python 3 and other dependencies
RUN apt-get update && apt-get install -y python3 python3-venv

WORKDIR /app
COPY . .

RUN npm install

# Create Python virtual environment
RUN python3 -m venv venv

# Make sure your start.sh is executable
RUN chmod +x start.sh

CMD ["bash", "start.sh"]