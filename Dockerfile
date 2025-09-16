FROM node:20

# Install Python 3, venv, and libGL for OpenCV
RUN apt-get update && apt-get install -y python3 python3-venv libgl1-mesa-glx

WORKDIR /app

# Install Node.js dependencies first (cache busts only if package files change)
COPY package*.json ./
RUN npm install

# Install Python dependencies first (cache busts only if requirements.txt changes)
COPY requirements.txt ./
RUN python3 -m venv venv
RUN venv/bin/pip install --upgrade pip
RUN venv/bin/pip install -r requirements.txt

# Copy the rest of the code
COPY . .

# Make sure your start.sh is executable
RUN chmod +x start.sh

CMD ["bash", "start.sh"]