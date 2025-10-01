FROM node:20

# Install Python 3, venv, and libGL for OpenCV
RUN apt-get update && apt-get install -y python3 python3-venv libgl1-mesa-glx

WORKDIR /app

# Install Node.js dependencies first (cache busts only if package files change)
COPY package*.json ./
RUN npm install

# Install Python dependencies first (cache busts only if requirements.txt changes)
COPY requirements.txt ./
RUN python3 -m venv venvi contact render support as my backend host, sayed when seeing out of memory events i got 2 opt 1.adjust ur code to use less memory ,,2.upgrade instance.....now we hve dne so far code adjusxtment in photo uplod and cleaning even creating buckets in superbse but didnt solve and i wnt free plan as testing what else we can do master
RUN venv/bin/pip install --upgrade pip
RUN venv/bin/pip install -r requirements.txt

# Copy the rest of the code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Make sure your start.sh is executable
RUN chmod +x start.sh

CMD ["bash", "start.sh"]