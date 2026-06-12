from tinysa_discord_bridge import classify_signal, estimate_distance_miles, CATEGORY_COLORS

# Test classification
tests = [
    95.2,    # FM
    433.2,   # ISM
    2417.0,  # Wi-Fi
    1090.0,  # ADS-B
    1575.0,  # GPS
    800.0,   # Cellular
    121.5,   # Emergency
    156.8,   # Marine
    300.0,   # NASA
    50.0,    # 6m Ham
    7000.0,  # Unknown
]

print('Frequency Classification Test:')
for freq in tests:
    entry = classify_signal(freq)
    color = CATEGORY_COLORS.get(entry['category'], '#808080')
    print(f'  {freq:8.1f} MHz -> {entry["name"]:40s} ({entry["category"]:10s}) {color}')

# Test distance estimation
print()
print('Distance Estimation Test:')
print(f'  FM 95.2MHz @ -65dBm  -> {estimate_distance_miles(95.2, -65):.1f} mi')
print(f'  Wi-Fi 2417MHz @ -55dBm -> {estimate_distance_miles(2417, -55):.1f} mi')
print(f'  Cell 800MHz @ -70dBm   -> {estimate_distance_miles(800, -70):.1f} mi')
print(f'  ADS-B 1090MHz @ -80dBm -> {estimate_distance_miles(1090, -80):.1f} mi')
print()
print('Tests passed!')
