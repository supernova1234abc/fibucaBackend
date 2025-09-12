FROM node:20

# Install Python 3 and venv
RUN apt-get update && apt-get install -y python3 python3-venv

WORKDIR /app
COPY . .

RUN npm install

# Create Python virtual environment
RUN python3 -m venv venv

# Install Python dependencies
RUN venv/bin/pip install --upgrade pip
RUN venv/bin/pip install -r requirements.txt

# Make sure your start.sh is executable
RUN chmod +x start.sh

CMD ["bash", "start.sh"]