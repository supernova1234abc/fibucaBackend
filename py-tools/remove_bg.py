from rembg import remove
from PIL import Image
import sys
import io

input_path = sys.argv[1]
output_path = sys.argv[2]

with open(input_path, 'rb') as i:
    input_data = i.read()

output_data = remove(input_data)
img = Image.open(io.BytesIO(output_data)).convert("RGBA")

# Create background matching card color (e.g. soft blue)
bg_color = (239, 246, 255, 255)  # Tailwind's blue-50
bg = Image.new("RGBA", img.size, bg_color)

# Composite image onto background
combined = Image.alpha_composite(bg, img)
combined.save(output_path)
