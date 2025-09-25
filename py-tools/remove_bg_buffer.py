# remove_bg_buffer.py
import sys
from rembg import remove
from PIL import Image
import io

# Read image from stdin
input_data = sys.stdin.buffer.read()

# Remove background
output_data = remove(input_data)
img = Image.open(io.BytesIO(output_data)).convert("RGBA")

# Add background color (e.g., Tailwind blue-50)
bg_color = (239, 246, 255, 255)
bg = Image.new("RGBA", img.size, bg_color)
combined = Image.alpha_composite(bg, img)

# Write processed image to stdout as PNG
buf = io.BytesIO()
combined.save(buf, format="PNG")
sys.stdout.buffer.write(buf.getvalue())
