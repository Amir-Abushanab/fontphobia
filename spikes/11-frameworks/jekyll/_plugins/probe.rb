# Jekyll build hooks: :site :post_write runs once after every page is written to _site.
Jekyll::Hooks.register :site, :post_render do |site|
  puts "[probe] site post_render (#{site.pages.size} pages, #{site.posts.docs.size} posts; nothing written yet)"
end

Jekyll::Hooks.register :site, :post_write do |site|
  urls = (site.pages + site.posts.docs).map(&:url).sort
  puts "[probe] site post_write #{site.dest} #{urls.inspect}"
end
